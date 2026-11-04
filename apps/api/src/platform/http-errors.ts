import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from 'express';

/**
 * Express 4 ignores a rejected handler promise, so the request hangs until the
 * client gives up. Every async route goes through this so a throw reaches
 * `errorHandler` instead.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Last middleware: log, then answer JSON with the error's status (500 by default). */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const status =
    typeof error?.status === 'number' && error.status >= 400 ? error.status : 500;
  req.log.error({ err: error, status }, 'request failed');
  // A response already under way (e.g. a stream): Express closes it.
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(status).json({
    error: error instanceof Error ? error.message : 'Internal server error',
  });
};
