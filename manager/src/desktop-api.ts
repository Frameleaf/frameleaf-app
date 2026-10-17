import express, { type Request, type ErrorRequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { DesktopGrants } from './desktop-grants.js';
import { Refusal, sha256, type Operation } from './contracts.js';
import type { ManagerLifecycle } from './runtime/contract.js';
import { Security } from './security.js';
import { Store } from './store.js';

const NATIVE = '/manager-api/desktop/';
const BROWSER = '/manager-api/desktop-grants';
const nativePaths = new Set(
  ['redeem', 'status', 'control', 'operation', 'resume'].map(
    (name) => NATIVE + name,
  ),
);
const browserPaths = new Set([
  BROWSER,
  ...['approve', 'reauthenticate', 'revoke'].map(
    (name) => `${BROWSER}/${name}`,
  ),
]);
const Action = z.enum(['start', 'stop', 'restart', 'backup']);
const Id = z.object({ id: z.string().uuid() }).strict();
const Credential = Id.extend({ password: z.string().max(256) }).strict();
const Empty = z.object({}).strict();

/** Mount at the application root, before the browser guard and body parser. */
export function desktopApi(
  store: Store,
  security: Security,
  grants: DesktopGrants,
  operations: ManagerLifecycle,
) {
  const router = express.Router({ caseSensitive: true, strict: true });
  const bodies = new WeakMap<Request, Buffer>();
  const json = express.json({
    limit: '16kb',
    verify: (request, _response, body) =>
      bodies.set(request as Request, Buffer.from(body)),
  });
  router.use((request, response, next) => {
    const native = request.path.startsWith(NATIVE);
    if (
      !native &&
      request.path !== BROWSER &&
      !request.path.startsWith(BROWSER + '/')
    )
      return next();
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    try {
      if (request.baseUrl || request.originalUrl !== request.path)
        throw new Refusal('desktop_request_invalid', 400);
      if (!(native ? nativePaths : browserPaths).has(request.path))
        throw new Refusal('desktop_route_unavailable', 404);
      const method = request.path === BROWSER ? 'GET' : 'POST';
      if (request.method !== method)
        throw new Refusal('desktop_method_invalid', 405);
      if (native) {
        // A native proof is a separate channel; cookies, browser fetches and bearer tokens confer no authority.
        if (
          request.headers.host !== new URL(security.origin).host ||
          [
            'origin',
            'cookie',
            'authorization',
            'sec-fetch-site',
            'sec-fetch-mode',
            'sec-fetch-dest',
          ].some((name) => request.headers[name] !== undefined)
        )
          throw new Refusal('desktop_transport_refused', 403);
        if (
          !request.is('application/json') ||
          (request.headers['content-encoding'] &&
            request.headers['content-encoding'] !== 'identity')
        )
          throw new Refusal('desktop_json_required', 415);
        security.limit(
          request.socket.remoteAddress ?? 'unknown',
          request.path === NATIVE + 'redeem' ? 'login' : 'desktop',
        );
        response.set(
          'Content-Security-Policy',
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        );
        return json(request, response, next);
      }
      security.guard(request, response, () => {
        try {
          if (request.method === 'POST')
            security.limit(request.socket.remoteAddress ?? 'unknown', 'login');
          json(request, response, next);
        } catch (error) {
          next(error);
        }
      });
    } catch (error) {
      next(error);
    }
  });
  const installation = () => {
    const current = operations.installation();
    if (!current) throw new Refusal('no_installation');
    return current;
  };
  const authorize = (request: Request, scope: string) => {
    const header = request.headers['x-frameleaf-manager-proof'];
    if (
      typeof header !== 'string' ||
      header.length > 4096 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(header)
    )
      throw new Refusal('desktop_grant_invalid', 401);
    let proof: unknown;
    try {
      const decoded = Buffer.from(header, 'base64');
      if (decoded.toString('base64') !== header) throw Error();
      proof = JSON.parse(decoded.toString('utf8'));
    } catch {
      throw new Refusal('desktop_grant_invalid', 401);
    }
    const body = bodies.get(request);
    if (!body) throw new Refusal('desktop_request_invalid', 400);
    const current = installation();
    grants.authorize(proof, {
      installationId: current.id,
      scope,
      method: request.method,
      path: request.path,
      bodySha256: sha256(body),
    });
    return current;
  };
  const operation = (id: string, installationId: string) => {
    const found = store.history().find((value) => value.id === id);
    if (
      !found ||
      found.input.installationId !== installationId ||
      !Action.safeParse(found.kind).success
    )
      throw new Refusal('desktop_operation_not_authorized', 403);
    return found;
  };
  const publicOperation = ({ input, receipts, ...safe }: Operation) => safe;

  router.get(BROWSER, (_request, response) =>
    response.json({ manager: grants.identity, grants: grants.list() }),
  );
  router.post(BROWSER + '/approve', async (request, response) => {
    const { password, ...device } = z
      .object({
        password: z.string().max(256),
        deviceId: z.string().uuid(),
        publicKey: z.string().max(44),
        scopes: z.array(z.string().max(16)).min(1).max(8),
      })
      .strict()
      .parse(request.body);
    response.json(
      await grants.approve(password, {
        ...device,
        installationId: installation().id,
      }),
    );
  });
  router.post(BROWSER + '/reauthenticate', async (request, response) => {
    const { password, id } = Credential.parse(request.body);
    await grants.reauthenticate(password, id);
    response.json({ authenticated: true });
  });
  router.post(BROWSER + '/revoke', async (request, response) => {
    const { password, id } = Credential.parse(request.body);
    await grants.revoke(password, id);
    response.json({ revoked: true });
  });
  router.post(NATIVE + 'redeem', (request, response) =>
    response.json(grants.redeem(request.body)),
  );
  router.post(NATIVE + 'status', (request, response) => {
    Empty.parse(request.body);
    const current = authorize(request, 'status');
    response.json({
      manager: grants.identity,
      installation: {
        id: current.id,
        name: current.name,
        release: current.release,
        port: current.port,
      },
      operations: store
        .history()
        .filter(
          (value) =>
            value.input.installationId === current.id &&
            Action.safeParse(value.kind).success,
        )
        .map(publicOperation),
    });
  });
  router.post(NATIVE + 'control', (request, response) => {
    const value = z
      .object({ action: Action, key: z.string().uuid() })
      .strict()
      .parse(request.body);
    const current = authorize(request, value.action);
    response.json({
      id: operations.control(value.action, value.key, current.id).id,
    });
  });
  router.post(NATIVE + 'operation', (request, response) => {
    const { id } = Id.parse(request.body),
      current = authorize(request, 'status');
    response.json(publicOperation(operation(id, current.id)));
  });
  router.post(NATIVE + 'resume', (request, response) => {
    const value = Id.extend({ action: Action }).strict().parse(request.body),
      current = authorize(request, value.action);
    if (operation(value.id, current.id).kind !== value.action)
      throw new Refusal('desktop_operation_not_authorized', 403);
    response.json({ id: operations.resume(value.id).id });
  });
  const errors: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    const large =
      !!error &&
      typeof error === 'object' &&
      'type' in error &&
      error.type === 'entity.too.large';
    const malformed = error instanceof SyntaxError || error instanceof ZodError;
    response
      .status(
        error instanceof Refusal
          ? error.status
          : large
            ? 413
            : malformed
              ? 400
              : 500,
      )
      .json({
        code:
          error instanceof Refusal
            ? error.code
            : large
              ? 'desktop_request_too_large'
              : malformed
                ? 'desktop_request_invalid'
                : 'desktop_operation_failed',
      });
  };
  router.use(errors);
  return router;
}
