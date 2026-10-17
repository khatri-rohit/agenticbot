// @org/logger — structured logging for the monorepo.
// Pure library: no HTTP server, no app concerns. Built on pino + pino-http.

export {
  createLogger,
  createHttpLogger,
  type Logger,
  type HttpLogger,
} from './lib/logger.js';
