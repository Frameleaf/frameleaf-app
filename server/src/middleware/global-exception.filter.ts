import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { ImmichHeader } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { isHttpException, onRouteError } from 'src/utils/logger.js';
import { serverErrorDisplay } from 'src/utils/server-error-display.js';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter<Error> {
  constructor(
    private logger: LoggingRepository,
    private cls: ClsService,
  ) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(error: Error, host: ArgumentsHost) {
    const http = host.switchToHttp();
    this.handleError(http.getRequest<Request>(), http.getResponse<Response>(), error);
  }

  handleError(req: Request, res: Response, error: Error) {
    const { canWrite } = onRouteError(req, res, error, this.logger);
    if (!canWrite) {
      return;
    }

    const { status, body } = this.fromError(error);

    res
      .header({
        [ImmichHeader.CorrelationId]: this.cls.getId(),
        'Content-Type': 'application/json',
        'Cache-Control':
          /^\/(?:api\/)?(?:icloud-sync\/edits\/evidence|system-config\/config-file\/(?:activation|reload))\/?$/i.test(
            req.path ?? '',
          )
            ? 'private, no-store'
            : 'no-store',
      })
      .status(status)
      .json(body);
  }

  private fromError(error: Error) {
    if (isHttpException(error)) {
      const status = error.getStatus();
      const response = error.getResponse();
      const body: Record<string, unknown> =
        typeof response === 'string' ? { message: response } : { ...(response as object) };

      // handle both request and response validation errors
      if (error instanceof ZodValidationException || error instanceof ZodSerializationException) {
        const zodError = error.getZodError();
        if (zodError instanceof ZodError && zodError.issues.length > 0) {
          const validationBody = { message: 'Validation failed', errors: zodError.issues };
          return {
            status,
            body: {
              ...validationBody,
              displayError: serverErrorDisplay(
                status,
                validationBody,
                error instanceof ZodValidationException ? 'request_validation_failed' : 'response_validation_failed',
              ),
            },
          };
        }
      }

      // remove fields injected by NestJS that duplicate the HTTP response line
      delete body['error'];
      delete body['statusCode'];
      return { status, body: { ...body, displayError: serverErrorDisplay(status, body) } };
    }

    return {
      status: 500,
      body: {
        message: 'Internal server error',
        displayError: serverErrorDisplay(500, {}),
      },
    };
  }
}
