import { ExecutionContext, ForbiddenException, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { controllers } from 'src/controllers/index.js';
import { MetadataKey } from 'src/enum.js';
import { AuthGuard, getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { AuthService } from 'src/services/auth.service.js';
import { VIEWER_READ_ONLY, VIEWER_SIGN_IN_REQUIRED } from 'src/utils/frameleaf-viewer.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/**
 * FL-235: a server Viewer (an account Frameleaf Cloud invited with `frameleaf_access = viewer`) runs
 * every route of the API through the real guard: reads answer, and every write, upload and admin
 * route refuses it.
 */
const reflector = new Reflector();

type Route = { id: string; Controller: Type; handler: (...args: unknown[]) => unknown; method: RequestMethod };

const routes: Route[] = controllers.flatMap((Controller) => {
  const prefix = reflector.get<string>(PATH_METADATA, Controller);
  return Object.getOwnPropertyNames(Controller.prototype).flatMap((name) => {
    const handler = Object.getOwnPropertyDescriptor(Controller.prototype, name)?.value;
    if (typeof handler !== 'function') {
      return [];
    }
    const method = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler);
    if (method === undefined) {
      return [];
    }
    const path = [prefix, reflector.get<string>(PATH_METADATA, handler)].filter((part) => part !== '/').join('/');
    return [{ id: `${RequestMethod[method]} ${path}`, Controller, handler, method }];
  });
});

const authenticatedRoutes = routes.filter((route) => !getAuthenticatedOptions(reflector, route.handler)?.public);
const viewerAllowed = (route: Route) =>
  route.method === RequestMethod.GET || reflector.get(MetadataKey.ViewerAllowed, route.handler) === true;
const reads = authenticatedRoutes.filter((route) => viewerAllowed(route));
const writes = authenticatedRoutes.filter((route) => !viewerAllowed(route));

const context = (route: Route, headers: Record<string, string>) =>
  ({
    getHandler: () => route.handler,
    getClass: () => route.Controller,
    switchToHttp: () => ({ getRequest: () => ({ headers, query: {}, path: `/api/${route.id.split(' ', 2)[1]}` }) }),
  }) as unknown as ExecutionContext;

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null).catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(ForbiddenException);
  return error as ForbiddenException;
};

describe('server Viewer access (FL-235)', () => {
  let mocks: ServiceMocks;
  let guard: AuthGuard;
  const viewer = UserFactory.create({ isAdmin: false });
  const bearer = { authorization: 'Bearer viewer-token' };

  // one service for the whole API: a fresh one per route would hold hundreds of full mock sets
  beforeAll(() => {
    let sut: AuthService;
    ({ sut, mocks } = newTestService(AuthService));
    guard = new AuthGuard({ setContext: vi.fn(), warn: vi.fn() } as never, reflector, sut);
  });

  beforeEach(() => {
    mocks.session.getByToken.mockResolvedValue({
      id: 'session-1',
      updatedAt: new Date(),
      user: viewer,
      pinExpiresAt: null,
      appVersion: null,
      oauthSid: null,
    } as never);
    mocks.frameleafAccount.getAccess.mockResolvedValue('viewer');
    mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1', sub: 'fl-sub' } as never);
  });

  it('covers the whole API', () => {
    expect(reads.length).toBeGreaterThan(300);
    expect(writes.length).toBeGreaterThan(300);
  });

  it.each(writes.map((route) => [route.id, route] as const))('refuses %s', async (_id, route) => {
    await refusal(guard.canActivate(context(route, bearer)));
  });

  it.each(reads.map((route) => [route.id, route] as const))('lets the viewer reach %s', async (_id, route) => {
    const admin = getAuthenticatedOptions(reflector, route.handler)?.admin;
    if (admin) {
      // an administration read is still an administration route
      await refusal(guard.canActivate(context(route, bearer)));
      return;
    }
    await expect(guard.canActivate(context(route, bearer))).resolves.toBe(true);
  });

  it('names the refusal of a write so the app can explain it', async () => {
    const upload = routes.find((route) => route.id === 'POST assets')!;
    const error = await refusal(guard.canActivate(context(upload, bearer)));
    expect(error.getResponse()).toMatchObject({ code: VIEWER_READ_ONLY, statusCode: 403 });
  });

  it('accepts a Viewer only through a Sign in with Frameleaf session', async () => {
    const timeline = routes.find((route) => route.id === 'GET timeline/buckets')!;
    mocks.frameleafAccount.getSession.mockResolvedValue(undefined);
    const error = await refusal(guard.canActivate(context(timeline, bearer)));
    expect(error.getResponse()).toMatchObject({ code: VIEWER_SIGN_IN_REQUIRED });

    // but such a session may always sign itself out
    const logout = routes.find((route) => route.id === 'POST auth/logout')!;
    await expect(guard.canActivate(context(logout, bearer))).resolves.toBe(true);
  });

  it('refuses a Viewer’s API key', async () => {
    mocks.apiKey.getKey.mockResolvedValue({
      id: 'key-1',
      permissions: ['all'],
      user: viewer,
    } as never);
    const timeline = routes.find((route) => route.id === 'GET timeline/buckets')!;
    const error = await refusal(guard.canActivate(context(timeline, { 'x-api-key': 'key' })));
    expect(error.getResponse()).toMatchObject({ code: VIEWER_SIGN_IN_REQUIRED });
  });

  it('leaves everyone else alone', async () => {
    mocks.frameleafAccount.getAccess.mockResolvedValue('editor');
    const upload = routes.find((route) => route.id === 'POST assets')!;
    await expect(guard.canActivate(context(upload, bearer))).resolves.toBe(true);
  });
});
