import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import pino, { type Logger, type LoggerOptions } from 'pino';
import pinoHttp, { type HttpLogger } from 'pino-http';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Root pino logger. JSON in production, pretty-printed in dev. Pass `service`
 * to stamp every line (useful for log aggregation); use `.child()` for scoped
 * request/feature context.
 */
export function createLogger(service?: string): Logger {
  const level = process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug');
  const options: LoggerOptions = {
    level,
    ...(service ? { base: { service } } : {}),
  };

  // pino-pretty is a dev-only transport; resolved by pino at runtime.
  if (!isProduction) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    };
  }

  return pino(options);
}

/**
 * Express/Node HTTP middleware on `pino-http`. Stamps each request with an
 * `x-request-id` (inbound header or fresh UUID), picks a level from the
 * response status, and skips auto-logging for SSE event streams and CORS
 * preflight. Route handlers get `req.log` carrying `reqId` automatically.
 */
export function createHttpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const inbound = req.headers['x-request-id'];
      const id = (Array.isArray(inbound) ? inbound[0] : inbound) ?? randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode} error`,
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: skipAutoLog },
  });
}

/** Skip noisy/long-lived transports: SSE event streams and CORS preflight. */
function skipAutoLog(req: IncomingMessage): boolean {
  if (req.method === 'OPTIONS') return true;
  return req.url?.includes('/events') ?? false;
}

export type { Logger, HttpLogger };