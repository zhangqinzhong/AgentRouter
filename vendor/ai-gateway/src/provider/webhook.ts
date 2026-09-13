import type { FastifyInstance, FastifyRequest } from 'fastify'
import { applyGatewayConfigInPlace, parseGatewayConfigFromRaw, parseProvidersFromRaw } from '../config'
import type { GatewayConfig } from '../types'
import { isObject, readBearerToken, readHeader } from '../utils'
import { hydrateProvidersFromExternalSource } from './external'

type WebhookEventType =
  | 'config.patch'
  | 'config.refresh'
  | 'agent.refresh'
  | 'provider.upsert'
  | 'provider.delete'
  | 'provider.refresh'

type PatchOperationType = 'set' | 'merge' | 'remove' | 'upsert' | 'remove_match'

interface RegisterProviderWebhookOptions {
  config: GatewayConfig;
  onConfigReload?: (config: GatewayConfig) => Promise<void>;
  onAgentRefresh?: (reason?: string) => Promise<void>;
}

interface ConfigPatchOperation {
  op: PatchOperationType;
  path: string;
  value?: unknown;
  matchKey?: string;
  matchValue?: unknown;
}

interface WebhookEvent {
  type: WebhookEventType;
  operations?: ConfigPatchOperation[];
  eventId?: string;
  reason?: string;
}

interface WebhookState {
  applyQueue: Promise<void>;
}

interface ApplyWebhookResult {
  applied: boolean;
  reason: string;
  operations?: number;
}

interface ParseEventResult {
  ok: true;
  event: WebhookEvent;
}

interface ParseEventError {
  ok: false;
  message: string;
}

const DEFAULT_PROVIDER_WEBHOOK_PATH = '/internal/provider/webhook'
const DEFAULT_PROVIDER_WEBHOOK_API_KEY_HEADER = 'x-provider-webhook-key'

export function registerProviderWebhookRoutes(
  fastify: FastifyInstance,
  options: RegisterProviderWebhookOptions
): void {
  if (!options.config.providerExternal?.enabled) {
    return
  }

  const routePath = normalizeHttpPath(readEnv('PROVIDER_WEBHOOK_PATH') || DEFAULT_PROVIDER_WEBHOOK_PATH)
  const state: WebhookState = {
    applyQueue: Promise.resolve()
  }

  fastify.post(routePath, async (request, reply) => {
    const auth = authenticateWebhookRequest(request)
    if (!auth.ok) {
      return reply.code(auth.statusCode).send({
        error: {
          message: auth.message
        }
      })
    }

    if (!isObject(request.body)) {
      return reply.code(400).send({
        error: {
          message: 'Request body must be a JSON object.'
        }
      })
    }

    const parseResult = parseWebhookEvent(request.body)
    if (!parseResult.ok) {
      return reply.code(400).send({
        error: {
          message: parseResult.message
        }
      })
    }

    const event = parseResult.event
    try {
      const result = await enqueueWebhookOperation(state, async () =>
        applyWebhookEvent(event, options)
      )

      const logPayload = {
        eventId: event.eventId,
        type: event.type,
        applied: result.applied,
        reason: result.reason,
        operations: result.operations
      }
      if (result.applied) {
        fastify.log.info(logPayload, 'Applied config webhook event.')
      } else {
        fastify.log.info(logPayload, 'Ignored config webhook event.')
      }

      return {
        ok: true,
        applied: result.applied,
        reason: result.reason,
        operations: result.operations
      }
    } catch (error) {
      request.log.warn(
        {
          eventId: event.eventId,
          type: event.type,
          details: error instanceof Error ? error.message : String(error)
        },
        'Failed to apply config webhook event.'
      )

      return reply.code(500).send({
        error: {
          message: 'Failed to apply config webhook event.'
        }
      })
    }
  })

  fastify.log.info(
    { path: routePath },
    'Config webhook endpoint enabled.'
  )
}

async function enqueueWebhookOperation<T>(
  state: WebhookState,
  operation: () => Promise<T>
): Promise<T> {
  const pending = state.applyQueue.then(operation, operation)
  state.applyQueue = pending.then(
    () => undefined,
    () => undefined
  )
  return pending
}

async function applyWebhookEvent(
  event: WebhookEvent,
  options: RegisterProviderWebhookOptions
): Promise<ApplyWebhookResult> {
  const { config } = options

  if (event.type === 'agent.refresh') {
    if (!options.onAgentRefresh) {
      return {
        applied: false,
        reason: 'agent_refresh_handler_not_configured'
      }
    }

    await options.onAgentRefresh(extractRefreshReason(event))
    return {
      applied: true,
      reason: 'agent_refreshed_from_storage'
    }
  }

  if (event.type === 'provider.refresh' || event.type === 'config.refresh') {
    await hydrateProvidersFromExternalSource(config)
    if (options.onConfigReload) {
      await options.onConfigReload(config)
    }
    return {
      applied: true,
      reason: 'refreshed_from_external_source'
    }
  }

  const operations = event.operations || []
  if (operations.length === 0) {
    return {
      applied: false,
      reason: 'no_patch_operations',
      operations: 0
    }
  }

  const nextRaw = cloneJsonObject(config as unknown as Record<string, unknown>)
  applyPatchOperations(nextRaw, operations)

  const nextConfig = parseGatewayConfigFromRaw(nextRaw)
  applyGatewayConfigInPlace(config, nextConfig)

  if (options.onConfigReload && shouldTriggerConfigReload(operations)) {
    await options.onConfigReload(config)
  }

  return {
    applied: true,
    reason: 'config_patched',
    operations: operations.length
  }
}

function parseWebhookEvent(payload: Record<string, unknown>): ParseEventResult | ParseEventError {
  const type = parseEventType(payload.type ?? payload.eventType)
  if (!type) {
    return {
      ok: false,
      message: 'Unsupported webhook event type.'
    }
  }

  const eventId = normalizeOptionalString(payload.eventId) || normalizeOptionalString(payload.id)

  if (type === 'provider.refresh' || type === 'config.refresh' || type === 'agent.refresh') {
    return {
      ok: true,
      event: {
        type,
        eventId,
        reason: normalizeOptionalString(payload.reason),
        operations: undefined
      }
    }
  }

  if (type === 'provider.upsert') {
    const rawProvider = readProviderPayload(payload)
    if (!rawProvider) {
      return {
        ok: false,
        message: 'provider.upsert requires provider payload.'
      }
    }

    const providers = parseProvidersFromRaw([rawProvider])
    if (providers.length === 0) {
      return {
        ok: false,
        message: 'provider.upsert payload does not contain a valid provider item.'
      }
    }

    return {
      ok: true,
      event: {
        type: 'config.patch',
        eventId,
        operations: [
          {
            op: 'upsert',
            path: 'providers',
            matchKey: 'name',
            value: providers[0]
          }
        ]
      }
    }
  }

  if (type === 'provider.delete') {
    const providerName = readProviderName(payload)
    if (!providerName) {
      return {
        ok: false,
        message: 'provider.delete requires providerName.'
      }
    }

    return {
      ok: true,
      event: {
        type: 'config.patch',
        eventId,
        operations: [
          {
            op: 'remove_match',
            path: 'providers',
            matchKey: 'name',
            matchValue: providerName
          }
        ]
      }
    }
  }

  const operations = parsePatchOperations(payload)
  if (!operations.ok) {
    return operations
  }

  return {
    ok: true,
    event: {
      type,
      eventId,
      operations: operations.operations
    }
  }
}

function parsePatchOperations(
  payload: Record<string, unknown>
): { ok: true; operations: ConfigPatchOperation[] } | ParseEventError {
  if (Array.isArray(payload.operations)) {
    return parsePatchOperationList(payload.operations)
  }

  if (Array.isArray(payload.ops)) {
    return parsePatchOperationList(payload.ops)
  }

  if (isObject(payload.patch)) {
    return {
      ok: true,
      operations: [
        {
          op: 'merge',
          path: '',
          value: payload.patch
        }
      ]
    }
  }

  return {
    ok: false,
    message: 'config.patch requires operations (or patch object).'
  }
}

function parsePatchOperationList(
  value: unknown[]
): { ok: true; operations: ConfigPatchOperation[] } | ParseEventError {
  const parsed: ConfigPatchOperation[] = []

  for (const entry of value) {
    if (!isObject(entry)) {
      return {
        ok: false,
        message: 'config.patch operations must be JSON objects.'
      }
    }

    const op = parsePatchOperationType(entry.op ?? entry.action)
    if (!op) {
      return {
        ok: false,
        message: 'Unsupported patch operation type.'
      }
    }

    const path = normalizePatchPath(entry.path)
    if (path === undefined) {
      return {
        ok: false,
        message: 'Patch operation path is required.'
      }
    }

    if ((op === 'set' || op === 'merge') && entry.value === undefined) {
      return {
        ok: false,
        message: `${op} operation requires value.`
      }
    }

    if (op === 'merge' && !isObject(entry.value)) {
      return {
        ok: false,
        message: 'merge operation value must be a JSON object.'
      }
    }

    if (op === 'upsert') {
      const matchKey = normalizeOptionalString(entry.matchKey)
      if (!matchKey) {
        return {
          ok: false,
          message: 'upsert operation requires matchKey.'
        }
      }
      if (!isObject(entry.value)) {
        return {
          ok: false,
          message: 'upsert operation value must be a JSON object.'
        }
      }

      parsed.push({
        op,
        path,
        matchKey,
        matchValue: entry.matchValue,
        value: entry.value
      })
      continue
    }

    if (op === 'remove_match') {
      const matchKey = normalizeOptionalString(entry.matchKey)
      if (!matchKey) {
        return {
          ok: false,
          message: 'remove_match operation requires matchKey.'
        }
      }
      if (entry.matchValue === undefined) {
        return {
          ok: false,
          message: 'remove_match operation requires matchValue.'
        }
      }

      parsed.push({
        op,
        path,
        matchKey,
        matchValue: entry.matchValue
      })
      continue
    }

    parsed.push({
      op,
      path,
      value: entry.value
    })
  }

  return {
    ok: true,
    operations: parsed
  }
}

function applyPatchOperations(target: Record<string, unknown>, operations: ConfigPatchOperation[]): void {
  for (const operation of operations) {
    if (operation.op === 'set') {
      setValueAtPath(target, operation.path, cloneJsonValue(operation.value))
      continue
    }

    if (operation.op === 'merge') {
      mergeValueAtPath(target, operation.path, cloneJsonObject(operation.value as Record<string, unknown>))
      continue
    }

    if (operation.op === 'remove') {
      removeValueAtPath(target, operation.path)
      continue
    }

    if (operation.op === 'upsert') {
      upsertArrayItemAtPath(
        target,
        operation.path,
        operation.matchKey as string,
        operation.matchValue,
        cloneJsonObject(operation.value as Record<string, unknown>)
      )
      continue
    }

    removeArrayItemAtPath(
      target,
      operation.path,
      operation.matchKey as string,
      operation.matchValue
    )
  }
}

function shouldTriggerConfigReload(operations: ConfigPatchOperation[]): boolean {
  return operations.some((operation) => {
    const normalizedPath = normalizePatchPath(operation.path) || ''
    if (!normalizedPath) {
      return true
    }

    return (
      normalizedPath === 'billingQueue' ||
      normalizedPath.startsWith('billingQueue.') ||
      normalizedPath === 'billingWebhook' ||
      normalizedPath.startsWith('billingWebhook.') ||
      normalizedPath === 'agent.eventQueue' ||
      normalizedPath.startsWith('agent.eventQueue.') ||
      normalizedPath === 'providerPlugins' ||
      normalizedPath.startsWith('providerPlugins.')
    )
  })
}

function setValueAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) {
    if (!isObject(value)) {
      throw new Error('set operation at root path requires object value.')
    }

    for (const key of Object.keys(target)) {
      delete target[key]
    }
    for (const [key, item] of Object.entries(value)) {
      target[key] = cloneJsonValue(item)
    }
    return
  }

  const { parent, key } = resolveParentContainer(target, path, true)
  if (!parent || !key) {
    return
  }

  parent[key] = value
}

function mergeValueAtPath(target: Record<string, unknown>, path: string, value: Record<string, unknown>): void {
  if (!path) {
    for (const [key, item] of Object.entries(value)) {
      target[key] = cloneJsonValue(item)
    }
    return
  }

  const current = getValueAtPath(target, path)
  if (!isObject(current)) {
    setValueAtPath(target, path, cloneJsonObject(value))
    return
  }

  for (const [key, item] of Object.entries(value)) {
    current[key] = cloneJsonValue(item)
  }
}

function removeValueAtPath(target: Record<string, unknown>, path: string): void {
  const { parent, key } = resolveParentContainer(target, path, false)
  if (!parent || !key) {
    return
  }

  delete parent[key]
}

function upsertArrayItemAtPath(
  target: Record<string, unknown>,
  path: string,
  matchKey: string,
  matchValue: unknown,
  value: Record<string, unknown>
): void {
  const list = getArrayAtPath(target, path, true)
  if (!list) {
    return
  }
  const resolvedMatchValue = matchValue ?? value[matchKey]

  const existingIndex = list.findIndex((item) => {
    if (!isObject(item)) {
      return false
    }
    return compareMatchValue(item[matchKey], resolvedMatchValue)
  })

  if (existingIndex >= 0) {
    list[existingIndex] = value
    return
  }

  list.push(value)
}

function removeArrayItemAtPath(
  target: Record<string, unknown>,
  path: string,
  matchKey: string,
  matchValue: unknown
): void {
  const list = getArrayAtPath(target, path, false)
  if (!list) {
    return
  }

  const next = list.filter((item) => {
    if (!isObject(item)) {
      return true
    }
    return !compareMatchValue(item[matchKey], matchValue)
  })

  setValueAtPath(target, path, next)
}

function getArrayAtPath(
  target: Record<string, unknown>,
  path: string,
  createIfMissing: boolean
): unknown[] | undefined {
  const current = getValueAtPath(target, path)
  if (Array.isArray(current)) {
    return current
  }

  if (current === undefined && createIfMissing) {
    setValueAtPath(target, path, [])
    const created = getValueAtPath(target, path)
    return Array.isArray(created) ? created : undefined
  }

  if (current !== undefined && !Array.isArray(current)) {
    throw new Error(`Patch path "${path}" is not an array.`)
  }

  return undefined
}

function getValueAtPath(target: Record<string, unknown>, path: string): unknown {
  const segments = splitPath(path)
  if (segments.length === 0) {
    return target
  }

  let current: unknown = target
  for (const segment of segments) {
    if (!isObject(current)) {
      return undefined
    }
    current = current[segment]
  }

  return current
}

function resolveParentContainer(
  target: Record<string, unknown>,
  path: string,
  createMissing: boolean
): { parent?: Record<string, unknown>; key?: string } {
  const segments = splitPath(path)
  if (segments.length === 0) {
    return {}
  }

  const key = segments[segments.length - 1]
  let current: unknown = target

  for (const segment of segments.slice(0, -1)) {
    if (!isObject(current)) {
      return {}
    }

    if (!isObject(current[segment])) {
      if (!createMissing) {
        return {}
      }
      current[segment] = {}
    }

    current = current[segment]
  }

  if (!isObject(current)) {
    return {}
  }

  return {
    parent: current,
    key
  }
}

function splitPath(path: string): string[] {
  const normalized = normalizePatchPath(path)
  if (!normalized) {
    return []
  }

  return normalized
    .split('.')
    .map((item) => item.trim())
    .filter(Boolean)
}

function compareMatchValue(current: unknown, expected: unknown): boolean {
  if (typeof current === 'string' && typeof expected === 'string') {
    return current.trim().toLowerCase() === expected.trim().toLowerCase()
  }

  return current === expected
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined
  }

  return JSON.parse(JSON.stringify(value))
}

function readProviderPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isObject(payload.provider)) {
    return payload.provider
  }

  if (isObject(payload.data) && isObject(payload.data.provider)) {
    return payload.data.provider
  }

  return undefined
}

function readProviderName(payload: Record<string, unknown>): string | undefined {
  const direct =
    normalizeOptionalString(payload.providerName) ||
    normalizeOptionalString(payload.name)
  if (direct) {
    return direct
  }

  if (isObject(payload.provider)) {
    return normalizeOptionalString(payload.provider.name)
  }

  return undefined
}

function parseEventType(value: unknown): WebhookEventType | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized === 'config.patch' || normalized === 'patch') {
    return 'config.patch'
  }

  if (normalized === 'config.refresh') {
    return 'config.refresh'
  }

  if (normalized === 'provider.upsert' || normalized === 'upsert') {
    return 'provider.upsert'
  }

  if (normalized === 'provider.delete' || normalized === 'delete' || normalized === 'remove') {
    return 'provider.delete'
  }

  if (normalized === 'provider.refresh' || normalized === 'refresh' || normalized === 'full_refresh') {
    return 'provider.refresh'
  }

  if (normalized === 'agent.refresh' || normalized === 'agent_refresh') {
    return 'agent.refresh'
  }

  return undefined
}

function extractRefreshReason(event: WebhookEvent): string | undefined {
  return normalizeOptionalString(event.reason)
}

function parsePatchOperationType(value: unknown): PatchOperationType | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized === 'set' || normalized === 'replace') {
    return 'set'
  }

  if (normalized === 'merge') {
    return 'merge'
  }

  if (normalized === 'remove' || normalized === 'delete') {
    return 'remove'
  }

  if (normalized === 'upsert') {
    return 'upsert'
  }

  if (normalized === 'remove_match' || normalized === 'delete_match') {
    return 'remove_match'
  }

  return undefined
}

function authenticateWebhookRequest(
  request: FastifyRequest
): { ok: true } | { ok: false; statusCode: number; message: string } {
  const expectedKey = readEnv('PROVIDER_WEBHOOK_API_KEY') || readEnv('PROVIDER_EXTERNAL_API_KEY')
  if (!expectedKey) {
    return {
      ok: false,
      statusCode: 503,
      message: 'PROVIDER_WEBHOOK_API_KEY is not configured.'
    }
  }

  const configuredHeader = normalizeHeaderName(
    readEnv('PROVIDER_WEBHOOK_API_KEY_HEADER') || DEFAULT_PROVIDER_WEBHOOK_API_KEY_HEADER
  )
  const headers = request.headers as Record<string, string | string[] | undefined>
  const suppliedFromConfiguredHeader = readHeader(headers[configuredHeader])
  const suppliedFromDefaultHeader = readHeader(headers[DEFAULT_PROVIDER_WEBHOOK_API_KEY_HEADER])
  const suppliedFromSyncHeader = readHeader(headers['x-gateway-sync-key'])
  const suppliedFromAuthorization = readBearerToken(readHeader(request.headers.authorization))
  const suppliedKey = (
    suppliedFromConfiguredHeader ||
    suppliedFromDefaultHeader ||
    suppliedFromSyncHeader ||
    suppliedFromAuthorization ||
    ''
  ).trim()

  if (!suppliedKey) {
    return {
      ok: false,
      statusCode: 401,
      message: 'Missing provider webhook api key.'
    }
  }

  if (suppliedKey !== expectedKey) {
    return {
      ok: false,
      statusCode: 403,
      message: 'Invalid provider webhook api key.'
    }
  }

  return { ok: true }
}

function normalizeHttpPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return DEFAULT_PROVIDER_WEBHOOK_PATH
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizePatchPath(value: unknown): string | undefined {
  if (value === '') {
    return ''
  }

  const normalized = normalizeOptionalString(value)
  if (normalized === undefined) {
    return undefined
  }

  if (normalized === '$' || normalized === '.' || normalized === '/') {
    return ''
  }

  return normalized.replace(/^\/+/, '').replace(/\//g, '.')
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase()
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}
