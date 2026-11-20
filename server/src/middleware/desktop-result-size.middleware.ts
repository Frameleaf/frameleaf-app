import { type RequestHandler, json } from 'express';

/** `POST /api/desktop/tasks/{id}/result`, with or without the API prefix. */
const DESKTOP_RESULT_ROUTE = /^(?:\/api)?\/desktop\/tasks\/[^/]+\/result\/?$/i;
export const DESKTOP_RESULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A desktop result over the 4 MB cap is refused with 400 `desktop_result_too_large` whichever way it is too
 * large: more bytes than the body limit, more characters than the payload field allows, or more bytes than
 * the cap in fewer characters. Checked here, ahead of validation and of the request proof, because those
 * answer an oversized payload with a general 400 or with 401 `desktop_worker_credential_invalid`, and a
 * desktop reads that 401 as "open a new session" instead of "fail this task".
 */
export const desktopResultSize = (bodyLimit: string | number = '10mb'): RequestHandler => {
  const parse = json({ limit: bodyLimit });
  return (request, response, next) => {
    if (request.method !== 'POST' || !DESKTOP_RESULT_ROUTE.test(request.path)) {
      next();
      return;
    }
    // Not logged: the request has not been authenticated yet, so anyone could fill the log this way.
    const refuse = () => {
      response.status(400).json({ message: 'desktop_result_too_large', error: 'Bad Request', statusCode: 400 });
    };
    parse(request, response, (error?: unknown) => {
      if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
        refuse();
        return;
      }
      if (error) {
        next(error);
        return;
      }
      const payload: unknown = (request.body as { payload?: unknown } | undefined)?.payload;
      if (typeof payload === 'string' && Buffer.byteLength(payload) > DESKTOP_RESULT_MAX_BYTES) {
        refuse();
        return;
      }
      next();
    });
  };
};
