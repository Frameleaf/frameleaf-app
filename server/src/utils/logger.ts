import { HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const isRequestAborted = (request: Request) => request.destroyed && !request.complete;
export const isHttpException = (error: Error): error is HttpException => error instanceof HttpException;
export const isConnectionAbortedError = (error: Error | any) => error.code === 'ECONNABORTED';

export const onRouteError = (req: Request | undefined, res: Response, error: Error, logger: LoggingRepository) => {
  // ignore client-closed connection
  if (res.headersSent || isConnectionAbortedError(error) || (req && isRequestAborted(req))) {
    logger.debug('Client aborted request');
    return { canWrite: false };
  }

  if (isHttpException(error)) {
    const status = error.getStatus();
    logger.debug(`HttpException(${status})`);
    return { canWrite: true };
  }

  if (error instanceof Error) {
    // Names and serialized stacks can contain private error text, including frame-shaped multiline messages.
    const errorClass = (
      [
        [TypeError, 'TypeError'],
        [RangeError, 'RangeError'],
        [SyntaxError, 'SyntaxError'],
        [ReferenceError, 'ReferenceError'],
        [URIError, 'URIError'],
        [EvalError, 'EvalError'],
        [AggregateError, 'AggregateError'],
      ] as const
    ).find(([ErrorClass]) => error instanceof ErrorClass)?.[1];
    logger.error(`Unknown route error\n${errorClass ?? 'Error'}`);
    return { canWrite: true };
  }

  return { canWrite: true };
};
