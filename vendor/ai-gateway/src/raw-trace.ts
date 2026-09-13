import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { ConcurrencyLimiter } from './agent/concurrency-limiter';
import { publishJsonEventToExternalSink } from './external-event-sink';
import type {
  GatewayRequestClientContext,
  GatewayRequestIdentity,
  Provider,
  RawTraceCaptureMode,
  RawTraceConfig,
  RawTracePartType,
} from './types';

type RawTraceLogger = {
  info?(payload: unknown, message?: string): void;
  warn?(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
};

type RawTraceRequest = FastifyRequest & {
  rawBodyText?: string;
  rawTraceCaptureSubmitted?: boolean;
};

interface RawTracePartCaptureInput {
  partType: RawTracePartType;
  content?: unknown;
  contentType?: string;
  redactionPolicy?: string;
}

export interface RawTraceCaptureInput {
  requestId: string;
  method: string;
  url: string;
  identity?: GatewayRequestIdentity;
  clientContext?: GatewayRequestClientContext;
  target?: {
    provider?: Provider;
    providerName?: string;
    model?: string;
  };
  parts: RawTracePartCaptureInput[];
}

interface RawTraceSyncManifestPart {
  partType: RawTracePartType;
  storageBackend: 'local';
  filePath?: string;
  contentType?: string;
  redactionPolicy?: string;
  sha256?: string;
  originalBytes?: number;
  storedBytes?: number;
  lineCount?: number;
}

interface RawTraceSyncManifest {
  requestId: string;
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
  sessionId?: string;
  agentId?: string;
  turnKey?: string;
  runId?: string;
  stepId?: string;
  workflow?: string;
  agentVersion?: string;
  promptVersion?: string;
  captureMode: RawTraceCaptureMode;
  status: 'uploaded';
  uploadAttempts: number;
  uploadedAt: string;
  failedReason?: string;
  target?: {
    provider?: Provider;
    providerName?: string;
    model?: string;
  };
  route: {
    method: string;
    url: string;
  };
  parts: RawTraceSyncManifestPart[];
}

let manager: RawTraceManager | undefined;

declare module 'fastify' {
  interface FastifyRequest {
    rawBodyText?: string;
    rawTraceCaptureSubmitted?: boolean;
  }
}

export function cacheRawRequestBody(request: FastifyRequest, rawBody: string): void {
  (request as RawTraceRequest).rawBodyText = rawBody;
}

export function markRawTraceCaptureSubmitted(request: FastifyRequest): boolean {
  const target = request as RawTraceRequest;
  if (target.rawTraceCaptureSubmitted) {
    return false;
  }

  target.rawTraceCaptureSubmitted = true;
  return true;
}

export function readRawRequestBody(
  request: FastifyRequest,
): string | undefined {
  const raw = (request as RawTraceRequest).rawBodyText;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export async function initializeRawTraceManager(
  config: RawTraceConfig,
  logger?: RawTraceLogger,
): Promise<void> {
  if (manager) {
    await manager.close();
    manager = undefined;
  }

  manager = new RawTraceManager(config, logger);
  await manager.initialize();
}

export async function closeRawTraceManager(): Promise<void> {
  if (!manager) {
    return;
  }

  await manager.close();
  manager = undefined;
}

export function enqueueRawTraceCapture(input: RawTraceCaptureInput): void {
  manager?.enqueue(input);
}

class RawTraceManager {
  private readonly limiter: ConcurrencyLimiter;
  private readonly inflight = new Set<Promise<void>>();
  private initialized = false;
  private warnedDisabled = false;
  private shuttingDown = false;

  constructor(
    private readonly config: RawTraceConfig,
    private readonly logger?: RawTraceLogger,
  ) {
    this.limiter = new ConcurrencyLimiter(config.uploaderConcurrency);
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      this.logger?.info?.(
        {
          enabled: false,
          mode: this.config.mode,
        },
        'Raw trace capture is disabled.',
      );
      this.initialized = true;
      return;
    }

    await mkdir(resolve(this.config.spoolDir), { recursive: true });
    this.logger?.info?.(
      {
        spoolDir: resolve(this.config.spoolDir),
        storageBackend: 'local',
        syncEnabled: this.config.sync.enabled,
        syncEndpoint: this.config.sync.endpoint,
        syncCommand: this.config.sync.command,
        syncTransport: this.config.sync.transport,
      },
      'Raw trace manager initialized.',
    );
    this.initialized = true;
  }

  enqueue(input: RawTraceCaptureInput): void {
    if (!this.initialized || this.shuttingDown) {
      return;
    }

    if (!this.config.enabled) {
      if (!this.warnedDisabled) {
        this.warnedDisabled = true;
        this.logger?.warn?.(
          {
            enabled: this.config.enabled,
          },
          'Raw trace capture skipped because it is disabled.',
        );
      }
      return;
    }

    const task = this.processWithRetry(input)
      .catch((error) => {
        this.logger?.warn?.(
          {
            requestId: input.requestId,
            details: error instanceof Error ? error.message : String(error),
          },
          'Raw trace capture failed.',
        );
      })
      .finally(() => {
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
    this.initialized = false;
    this.warnedDisabled = false;
  }

  private async processWithRetry(input: RawTraceCaptureInput): Promise<void> {
    const release = await this.limiter.acquire();
    try {
      let lastError: unknown;
      for (
        let attempt = 1;
        attempt <= this.config.maxAttempts;
        attempt += 1
      ) {
        try {
          await this.process(input, attempt);
          return;
        } catch (error) {
          lastError = error;
          if (attempt >= this.config.maxAttempts) {
            break;
          }

          await delay(this.config.baseDelayMs * attempt);
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    } finally {
      release();
    }
  }

  private async process(
    input: RawTraceCaptureInput,
    attempt: number,
  ): Promise<void> {
    const bundleDir = resolve(this.config.spoolDir, sanitizePathToken(input.requestId));
    await mkdir(bundleDir, { recursive: true });

    const manifestParts: RawTraceSyncManifestPart[] = [];
    const uploadedAt = new Date().toISOString();

    for (const part of input.parts) {
      const serialized = serializeRawTracePart(part);
      if (!serialized) {
        continue;
      }

      if (serialized.buffer.length > this.config.maxPartBytes) {
        this.logger?.warn?.(
          {
            requestId: input.requestId,
            partType: part.partType,
            bytes: serialized.buffer.length,
            maxPartBytes: this.config.maxPartBytes,
          },
          'Raw trace part skipped because it exceeds the configured max part size.',
        );
        continue;
      }

      const fileBaseName = buildPartFileBaseName(part.partType, serialized.extension);
      const rawPath = join(bundleDir, fileBaseName);
      await writeFile(rawPath, serialized.buffer);

      const rawStat = await stat(rawPath);
      manifestParts.push({
        partType: part.partType,
        storageBackend: 'local',
        filePath: rawPath,
        contentType: serialized.contentType,
        redactionPolicy:
          part.redactionPolicy ||
          (this.config.mode === 'body_redacted'
            ? 'body_redacted'
            : 'none'),
        sha256: sha256Hex(serialized.buffer),
        originalBytes: serialized.buffer.length,
        storedBytes: rawStat.size,
        lineCount: serialized.lineCount,
      });
    }

    if (manifestParts.length === 0) {
      await safeRemoveDir(bundleDir);
      return;
    }

    const manifest: RawTraceSyncManifest = {
      requestId: input.requestId,
      organizationId: sanitizeOptionalString(input.identity?.organizationId),
      userId: sanitizeOptionalString(input.identity?.userId),
      apiKeyId: sanitizeOptionalString(input.identity?.apiKeyId),
      sessionId: sanitizeOptionalString(input.clientContext?.sessionId),
      agentId: sanitizeOptionalString(input.clientContext?.agentId),
      turnKey: sanitizeOptionalString(input.clientContext?.clientRequestId),
      runId: sanitizeOptionalString(input.clientContext?.runId),
      stepId: sanitizeOptionalString(input.clientContext?.stepId),
      workflow: sanitizeOptionalString(input.clientContext?.workflow),
      agentVersion: sanitizeOptionalString(input.clientContext?.version),
      promptVersion: sanitizeOptionalString(input.clientContext?.promptVersion),
      captureMode: this.config.mode,
      status: 'uploaded',
      uploadAttempts: attempt,
      uploadedAt,
      target: input.target,
      route: {
        method: input.method,
        url: input.url,
      },
      parts: manifestParts,
    };

    await writeFile(
      join(bundleDir, 'manifest.json'),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );

    await this.syncManifest(manifest);
  }

  private async syncManifest(manifest: RawTraceSyncManifest): Promise<void> {
    if (
      !this.config.sync.enabled ||
      (this.config.sync.transport === 'stdio'
        ? !this.config.sync.command
        : !this.config.sync.endpoint)
    ) {
      this.logger?.warn?.(
        {
          requestId: manifest.requestId,
          syncEnabled: this.config.sync.enabled,
          endpoint: this.config.sync.endpoint,
          command: this.config.sync.command,
          transport: this.config.sync.transport,
          storageBackend: manifest.parts[0]?.storageBackend,
        },
        'Raw trace manifest was stored but sync endpoint is not configured. Server will need manifest sync or shared local access to query it.',
      );
      return;
    }

    await publishJsonEventToExternalSink(manifest, this.config.sync);
  }
}

function serializeRawTracePart(
  input: RawTracePartCaptureInput,
): {
  buffer: Buffer;
  contentType: string;
  extension: string;
  lineCount?: number;
} | null {
  if (input.content === undefined || input.content === null) {
    return null;
  }

  if (Buffer.isBuffer(input.content)) {
    return {
      buffer: input.content,
      contentType: input.contentType || 'application/octet-stream',
      extension: 'bin',
    };
  }

  if (typeof input.content === 'string') {
    return {
      buffer: Buffer.from(input.content, 'utf8'),
      contentType: input.contentType || 'text/plain; charset=utf-8',
      extension: guessTextExtension(input.contentType),
      lineCount: countLines(input.content),
    };
  }

  const serialized = safeStringify(input.content);
  if (!serialized) {
    return null;
  }

  return {
    buffer: Buffer.from(serialized, 'utf8'),
    contentType: input.contentType || 'application/json; charset=utf-8',
    extension: guessTextExtension(input.contentType || 'application/json'),
    lineCount: countLines(serialized),
  };
}

function buildPartFileBaseName(
  partType: RawTracePartType,
  extension: string,
): string {
  return `${partType}.${extension}`;
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function sanitizePathToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function guessTextExtension(contentType?: string): string {
  const normalized = contentType?.toLowerCase() || '';
  if (normalized.includes('json')) {
    return 'json';
  }
  if (normalized.includes('ndjson')) {
    return 'ndjson';
  }
  if (normalized.includes('xml')) {
    return 'xml';
  }
  return 'txt';
}

function safeStringify(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') {
      return value;
    }

    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split('\n').length;
}

async function safeRemoveDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    // ignore spool cleanup failures
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
