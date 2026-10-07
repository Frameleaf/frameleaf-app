import { HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FrameleafSetupErrorCode } from 'src/dtos/frameleaf-server-setup.dto.js';
import { ImmichHeader } from 'src/enum.js';
import { GlobalExceptionFilter } from 'src/middleware/global-exception.filter.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { setupRefusal } from 'src/utils/frameleaf-setup-gate.js';
import { serverErrorDisplay } from 'src/utils/server-error-display.js';

type Vector = {
  name: string;
  input: { status: number; response: string | Record<string, unknown> };
  expected: Record<string, unknown>;
};
const vectors = JSON.parse(
  readFileSync(new URL('../../test/fixtures/server-error-display-v1.json', import.meta.url), 'utf8'),
) as { producer: Vector[] };

const logger = () => ({ setContext: vi.fn(), debug: vi.fn(), error: vi.fn() });
const respond = (error: Error, id = 'request-a', log = logger()) => {
  const res = { headersSent: false, header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  const sut = new GlobalExceptionFilter(log as unknown as LoggingRepository, { getId: () => id } as ClsService);
  sut.handleError({ complete: true } as Request, res as unknown as Response, error);
  return { res, log, body: res.json.mock.calls[0]?.[0] as Record<string, any> };
};

describe('FL-328 server error display contract', () => {
  it.each(vectors.producer)('produces the exact $name wire fixture', ({ input, expected }) => {
    const { res, body } = respond(new HttpException(input.response, input.status));
    expect(res.status).toHaveBeenCalledWith(input.status);
    expect(body).toEqual(expected);
    expect(res.header).toHaveBeenCalledWith({
      [ImmichHeader.CorrelationId]: 'request-a',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
  });

  it('keeps real setup refusal semantics and its allowed argument', () => {
    const { res, body } = respond(setupRefusal(FrameleafSetupErrorCode.CodeInvalid, { attemptsLeft: 2 }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(body.code).toBe('setup_code_invalid');
    expect(body.attemptsLeft).toBe(2);
    expect(body.displayError.args).toEqual({ attemptsLeft: 2 });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2', { token: 'private' }])(
    'excludes invalid structured arguments: %j',
    (attemptsLeft) => {
      expect(serverErrorDisplay(401, { code: 'setup_code_invalid', attemptsLeft }).args).toEqual({});
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'future_refusal'])(
    'ignores unknown argument schemas: %s',
    (code) => {
      expect(serverErrorDisplay(403, { code, attemptsLeft: 2, args: { token: 'private' } }).args).toEqual({});
    },
  );

  it('distinguishes request and response validation without interpreting English', () => {
    const validation = z.object({ count: z.number() }).safeParse({ count: 'wrong' });
    if (validation.success) {
      throw new Error('Expected invalid fixture');
    }
    for (const [error, status, code] of [
      [new ZodValidationException(validation.error), 400, 'request_validation_failed'],
      [new ZodSerializationException(validation.error), 500, 'response_validation_failed'],
    ] as const) {
      const { res, body } = respond(error);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(body.errors).toEqual(validation.error.issues);
      expect(body.displayError).toEqual(serverErrorDisplay(status, {}, code));
    }
  });

  it('keeps diagnostics and unexpected-error responses free of private error text and stacks', () => {
    const log = logger();
    const secret = 'private-provider-account-a';
    const error = new Error(secret);
    error.stack = secret;
    const { res, body } = respond(error, 'request-a', log);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body).toEqual({ message: 'Internal server error', displayError: serverErrorDisplay(500, {}) });
    respond(new HttpException({ message: secret, code: secret, data: { secret } }, 403), 'request-b', log);
    expect(log.debug).toHaveBeenCalledWith('HttpException(403)');
    expect(log.error).toHaveBeenCalledExactlyOnceWith('Unknown route error');
    expect(JSON.stringify([body, log.debug.mock.calls, log.error.mock.calls])).not.toContain(secret);
  });

  it('does not reuse another request’s allowed arguments, content or correlation id', () => {
    const a = respond(new HttpException({ code: 'setup_code_invalid', attemptsLeft: 2, message: 'Account A' }, 401));
    const b = respond(
      new HttpException({ code: 'setup_code_invalid', attemptsLeft: 0, message: 'Account B' }, 401),
      'request-b',
    );
    expect(a.body.displayError.args).toEqual({ attemptsLeft: 2 });
    expect(b.body.displayError.args).toEqual({ attemptsLeft: 0 });
    expect(JSON.stringify(b.body)).not.toContain('Account A');
    expect(b.res.header).toHaveBeenCalledWith(expect.objectContaining({ [ImmichHeader.CorrelationId]: 'request-b' }));
  });

  it.each([{ headersSent: true }, { destroyed: true, complete: false }, { code: 'ECONNABORTED' }])(
    'preserves aborted and already-sent response handling: %j',
    (state) => {
      const log = logger();
      const sut = new GlobalExceptionFilter(log as unknown as LoggingRepository, { getId: () => 'a' } as ClsService);
      const res = { headersSent: state.headersSent, json: vi.fn() };
      sut.handleError(state as Request, res as unknown as Response, Object.assign(new Error('private'), state));
      expect(res.json).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledExactlyOnceWith('Client aborted request');
    },
  );
});
