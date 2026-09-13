import type { GatewayRequestIdentity } from '../types';
import { isObject } from '../utils';

export const GATEWAY_REQUEST_IDENTITY_METADATA_KEY = 'gatewayRequestIdentity';

export function mergeGatewayRequestIdentityMetadata(
  metadata: Record<string, unknown> | undefined,
  identity?: GatewayRequestIdentity
): Record<string, unknown> | undefined {
  if (!identity?.billingSubjectKey) {
    return metadata;
  }

  return {
    ...(metadata || {}),
    [GATEWAY_REQUEST_IDENTITY_METADATA_KEY]: sanitizeGatewayRequestIdentity(identity)
  };
}

export function readGatewayRequestIdentityMetadata(
  metadata: unknown
): GatewayRequestIdentity | undefined {
  if (!isObject(metadata)) {
    return undefined;
  }

  const rawIdentity = metadata[GATEWAY_REQUEST_IDENTITY_METADATA_KEY];
  if (!isObject(rawIdentity)) {
    return undefined;
  }

  const billingSubjectKey = readOptionalString(rawIdentity.billingSubjectKey);
  const source = readIdentitySource(rawIdentity.source);
  if (!billingSubjectKey || !source) {
    return undefined;
  }

  return sanitizeGatewayRequestIdentity({
    source,
    billingSubjectKey,
    userId: readOptionalString(rawIdentity.userId),
    tenantId: readOptionalString(rawIdentity.tenantId),
    subject: readOptionalString(rawIdentity.subject),
    organizationId: readOptionalString(rawIdentity.organizationId),
    plan: readOptionalString(rawIdentity.plan),
    apiKeyId: readOptionalString(rawIdentity.apiKeyId)
  });
}

export function findLatestGatewayRequestIdentityInMessages(
  messages: Array<{ metadata?: Record<string, unknown> }>
): GatewayRequestIdentity | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const identity = readGatewayRequestIdentityMetadata(messages[index]?.metadata);
    if (identity) {
      return identity;
    }
  }

  return undefined;
}

function sanitizeGatewayRequestIdentity(
  identity: GatewayRequestIdentity
): GatewayRequestIdentity {
  return {
    source: identity.source,
    billingSubjectKey: identity.billingSubjectKey,
    userId: readOptionalString(identity.userId),
    tenantId: readOptionalString(identity.tenantId),
    subject: readOptionalString(identity.subject),
    organizationId: readOptionalString(identity.organizationId),
    plan: readOptionalString(identity.plan),
    apiKeyId: readOptionalString(identity.apiKeyId)
  };
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function readIdentitySource(value: unknown): GatewayRequestIdentity['source'] | undefined {
  return value === 'trusted_header' || value === 'http_introspection' || value === 'static_api_key'
    ? value
    : undefined;
}
