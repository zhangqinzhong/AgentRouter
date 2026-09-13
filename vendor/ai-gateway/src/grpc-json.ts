import { connect, constants, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';

export interface GrpcJsonUnaryOptions {
  endpoint: string;
  defaultPath: string;
  payload: unknown;
  timeoutMs: number;
  headers?: Record<string, string>;
}

export interface GrpcJsonUnaryResponse {
  headers: IncomingHttpHeaders;
  trailers: IncomingHttpHeaders;
  payload: unknown;
}

export async function invokeGrpcJsonUnary(options: GrpcJsonUnaryOptions): Promise<GrpcJsonUnaryResponse> {
  const target = parseGrpcEndpoint(options.endpoint, options.defaultPath);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    let session: ClientHttp2Session | undefined;
    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders = {};
    let trailers: IncomingHttpHeaders = {};

    const timer = setTimeout(() => {
      finish(undefined, new Error(`gRPC JSON request timeout after ${timeoutMs}ms.`));
    }, timeoutMs);

    const finish = (payload?: unknown, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      session?.close();
      if (error) {
        reject(error);
        return;
      }
      resolve({
        headers: responseHeaders,
        trailers,
        payload
      });
    };

    try {
      session = connect(target.authority);
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    session.once('error', (error) => {
      finish(undefined, error instanceof Error ? error : new Error(String(error)));
    });

    const stream = session.request({
      ':method': 'POST',
      ':path': target.path,
      'content-type': 'application/grpc+json',
      te: 'trailers',
      ...(options.headers || {})
    });

    stream.once('response', (headers) => {
      responseHeaders = headers;
    });
    stream.once('trailers', (headers) => {
      trailers = headers;
    });
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once('error', (error) => {
      finish(undefined, error instanceof Error ? error : new Error(String(error)));
    });
    stream.once('end', () => {
      try {
        const statusCode = Number(responseHeaders[':status'] || 0);
        if (statusCode && statusCode >= 400) {
          throw new Error(`gRPC JSON endpoint returned HTTP ${statusCode}.`);
        }

        const grpcStatus = readGrpcStatus(trailers) || readGrpcStatus(responseHeaders);
        if (grpcStatus && grpcStatus !== '0') {
          const message = readGrpcMessage(trailers) || readGrpcMessage(responseHeaders);
          throw new Error(`gRPC JSON endpoint returned status ${grpcStatus}${message ? `: ${message}` : ''}.`);
        }

        finish(parseGrpcJsonResponse(Buffer.concat(chunks)));
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    });

    stream.end(encodeGrpcJsonMessage(options.payload));
  });
}

export function encodeGrpcJsonMessage(payload: unknown): Buffer {
  const message = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(5 + message.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

function parseGrpcJsonResponse(body: Buffer): unknown {
  if (body.length === 0) {
    return {};
  }

  const messages: unknown[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 5 > body.length) {
      throw new Error('gRPC JSON response frame is truncated.');
    }

    const compressed = body.readUInt8(offset);
    if (compressed !== 0) {
      throw new Error('gRPC JSON compressed responses are not supported.');
    }

    const length = body.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > body.length) {
      throw new Error('gRPC JSON response frame length exceeds payload size.');
    }

    const raw = body.subarray(start, end).toString('utf8').trim();
    messages.push(raw ? JSON.parse(raw) : {});
    offset = end;
  }

  return messages.length === 1 ? messages[0] : messages;
}

function parseGrpcEndpoint(endpoint: string, defaultPath: string): { authority: string; path: string } {
  const parsed = new URL(endpoint);
  const protocol =
    parsed.protocol === 'grpc:'
      ? 'http:'
      : parsed.protocol === 'grpcs:'
        ? 'https:'
        : parsed.protocol;

  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('gRPC JSON endpoint must use grpc://, grpcs://, http://, or https://.');
  }

  const path = normalizeGrpcPath(parsed.pathname, defaultPath);
  return {
    authority: `${protocol}//${parsed.host}`,
    path: `${path}${parsed.search}`
  };
}

function normalizeGrpcPath(pathname: string, defaultPath: string): string {
  const normalized = pathname.trim();
  if (normalized && normalized !== '/') {
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }

  return defaultPath.startsWith('/') ? defaultPath : `/${defaultPath}`;
}

function readGrpcStatus(headers: IncomingHttpHeaders): string | undefined {
  const value = headers['grpc-status'];
  return Array.isArray(value) ? value[0] : value;
}

function readGrpcMessage(headers: IncomingHttpHeaders): string | undefined {
  const value = headers['grpc-message'];
  const message = Array.isArray(value) ? value[0] : value;
  return message ? decodeURIComponent(message) : undefined;
}

function normalizeTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 5000;
}

export const GRPC_HTTP2_NO_ERROR = constants.NGHTTP2_NO_ERROR;
