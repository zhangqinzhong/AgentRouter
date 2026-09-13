import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  buildJsonRpcErrorResponse,
  handleMcpJsonRpcMethod,
  parseJsonRpcRequest
} from './jsonrpc';
import { readHeader } from '../utils';
import { McpGatewayError, type McpGatewayPrincipalContext, type McpGatewayRuntime } from './runtime';

const mcpGatewayWebSocketMaxPayloadBytes = 1024 * 1024;
const mcpGatewayWebSocketMaxInFlightMessages = 16;

export function registerMcpGatewayWebSocketRoute(
  fastify: FastifyInstance,
  runtime: McpGatewayRuntime
): void {
  if (!runtime.enabled || !runtime.websocketEnabled || !runtime.websocketEndpointPath) {
    return;
  }

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: mcpGatewayWebSocketMaxPayloadBytes
  });
  const contextBySocket = new WeakMap<WebSocket, McpGatewayPrincipalContext>();

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = safeParseRequestUrl(request);
    if (!url || url.pathname !== runtime.websocketEndpointPath) {
      return;
    }

    const headers = cloneHeaders(request.headers);
    if (runtime.websocketAllowQueryToken && !hasApiKeyHeader(headers)) {
      const queryToken = url.searchParams.get(runtime.websocketQueryTokenParam)?.trim();
      if (queryToken) {
        headers.authorization = `Bearer ${queryToken}`;
      }
    }

    const authResult = runtime.authenticateSocket(headers, request.socket.remoteAddress);
    if (!authResult.ok || !authResult.context) {
      const statusCode = authResult.statusCode || 401;
      const oauthContext = buildOauthRequestContext(request, runtime.endpointPath);
      const challengeHeader =
        runtime.oauthEnabled && statusCode === 401
          ? runtime.buildOAuthWwwAuthenticateHeader(
              oauthContext,
              'invalid_token',
              authResult.error || 'Unauthorized'
            )
          : undefined;

      rejectUpgrade(
        socket,
        statusCode,
        authResult.error || 'Unauthorized',
        challengeHeader
          ? {
              'WWW-Authenticate': challengeHeader
            }
          : undefined
      );
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      contextBySocket.set(ws, authResult.context as McpGatewayPrincipalContext);
      websocketServer.emit('connection', ws, request);
    });
  };

  websocketServer.on('connection', (socket) => {
    const context = contextBySocket.get(socket);
    if (!context) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    let inFlightMessages = 0;
    socket.on('message', (raw) => {
      if (inFlightMessages >= mcpGatewayWebSocketMaxInFlightMessages) {
        socket.close(1013, 'Too many pending MCP messages.');
        return;
      }

      inFlightMessages += 1;
      void handleMessage(runtime, socket, context, raw).finally(() => {
        inFlightMessages = Math.max(0, inFlightMessages - 1);
      });
    });

    socket.on('error', (error) => {
      fastify.log.warn(
        {
          details: error instanceof Error ? error.message : String(error)
        },
        'MCP WebSocket connection error.'
      );
    });
  });

  fastify.server.on('upgrade', onUpgrade);
  fastify.addHook('onClose', async () => {
    fastify.server.off('upgrade', onUpgrade);
    for (const client of websocketServer.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
  });
}

async function handleMessage(
  runtime: McpGatewayRuntime,
  socket: WebSocket,
  context: McpGatewayPrincipalContext,
  rawData: RawData
): Promise<void> {
  const payload = parseMessagePayload(rawData);
  if (!payload.ok) {
    sendJson(
      socket,
      buildJsonRpcErrorResponse(null, -32700, payload.error || 'Invalid JSON payload.')
    );
    return;
  }

  const parsed = parseJsonRpcRequest(payload.body);
  if (!parsed.ok) {
    sendJson(
      socket,
      buildJsonRpcErrorResponse(null, -32600, parsed.error || 'Invalid JSON-RPC request.')
    );
    return;
  }

  const request = parsed.request;
  try {
    const result = await handleMcpJsonRpcMethod(runtime, context, request.method, request.params);
    if (request.id === null) {
      return;
    }

    sendJson(socket, {
      jsonrpc: '2.0',
      id: request.id,
      result
    });
  } catch (error) {
    if (request.id === null) {
      return;
    }

    sendJson(socket, toJsonRpcError(request.id, error));
  }
}

function parseMessagePayload(rawData: RawData): { ok: true; body: unknown } | { ok: false; error: string } {
  if (rawDataByteLength(rawData) > mcpGatewayWebSocketMaxPayloadBytes) {
    return {
      ok: false,
      error: 'JSON-RPC payload exceeds MCP WebSocket message limit.'
    };
  }

  const text = rawToString(rawData);
  try {
    return {
      ok: true,
      body: JSON.parse(text)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function rawToString(rawData: RawData): string {
  if (typeof rawData === 'string') {
    return rawData;
  }

  if (Buffer.isBuffer(rawData)) {
    return rawData.toString('utf8');
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString('utf8');
  }

  return Buffer.from(rawData).toString('utf8');
}

function rawDataByteLength(rawData: RawData): number {
  if (typeof rawData === 'string') {
    return Buffer.byteLength(rawData, 'utf8');
  }

  if (Buffer.isBuffer(rawData)) {
    return rawData.byteLength;
  }

  if (Array.isArray(rawData)) {
    return rawData.reduce((total, item) => total + rawDataByteLength(item), 0);
  }

  if (rawData instanceof ArrayBuffer) {
    return rawData.byteLength;
  }

  return 0;
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function toJsonRpcError(id: string | number | null, error: unknown): Record<string, unknown> {
  if (error instanceof McpGatewayError) {
    const code = Number.isInteger(error.code) ? error.code : -32000;
    return buildJsonRpcErrorResponse(id, code, error.message, error.data);
  }

  const message = error instanceof Error ? error.message : String(error);
  return buildJsonRpcErrorResponse(id, -32603, message);
}

function safeParseRequestUrl(request: IncomingMessage): URL | undefined {
  const host = request.headers.host || 'localhost';
  const path = request.url || '/';
  try {
    return new URL(path, `http://${host}`);
  } catch {
    return undefined;
  }
}

function cloneHeaders(headers: IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  const cloned: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    cloned[key] = value;
  }

  return cloned;
}

function hasApiKeyHeader(headers: Record<string, string | string[] | undefined>): boolean {
  const fromApiKey = readHeaderValue(headers['x-api-key']);
  if (fromApiKey) {
    return true;
  }

  const fromMcpKey = readHeaderValue(headers['x-mcp-key']);
  if (fromMcpKey) {
    return true;
  }

  const authorization = readHeaderValue(headers.authorization);
  return Boolean(authorization);
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }

  return undefined;
}

function rejectUpgrade(
  socket: Socket,
  statusCode: number,
  message: string,
  extraHeaders?: Record<string, string>
): void {
  const statusMessage = resolveStatusMessage(statusCode);
  const body = JSON.stringify({
    error: message
  });
  const extraHeaderLines = extraHeaders
    ? Object.entries(extraHeaders)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('')
    : '';
  const response =
    `HTTP/1.1 ${statusCode} ${statusMessage}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: application/json\r\n' +
    extraHeaderLines +
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
    '\r\n' +
    body;

  socket.write(response);
  socket.destroy();
}

function resolveStatusMessage(statusCode: number): string {
  if (statusCode === 401) {
    return 'Unauthorized';
  }

  if (statusCode === 403) {
    return 'Forbidden';
  }

  if (statusCode === 404) {
    return 'Not Found';
  }

  return 'Bad Request';
}

function buildOauthRequestContext(request: IncomingMessage, endpointPath: string): {
  origin: string;
  endpointPath: string;
} {
  const protocol = readHeader(request.headers['x-forwarded-proto']) || 'http';
  const host =
    readHeader(request.headers['x-forwarded-host']) || readHeader(request.headers.host) || 'localhost';

  return {
    origin: `${protocol}://${host}`,
    endpointPath
  };
}
