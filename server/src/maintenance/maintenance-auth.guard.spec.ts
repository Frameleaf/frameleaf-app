import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import {
  MaintenanceAuthGuard,
  type MaintenanceAuthRequest,
  MaintenanceRoute,
} from 'src/maintenance/maintenance-auth.guard.js';

class Routes {
  @MaintenanceRoute()
  protected() {}
  public() {}
}

const fixture = (handler: () => void) => {
  const authenticate = vi.fn();
  const request = { headers: { authorization: 'fixture-token' } } as MaintenanceAuthRequest;
  const context = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new MaintenanceAuthGuard({ setContext: vi.fn() } as never, new Reflector(), { authenticate } as never);
  return { authenticate, request, context, guard };
};

it('leaves undecorated maintenance routes public', async () => {
  const { guard, context, authenticate } = fixture(Routes.prototype.public);
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(authenticate).not.toHaveBeenCalled();
});

it('authenticates decorated handlers and attaches the returned context', async () => {
  const { guard, context, authenticate, request } = fixture(Routes.prototype.protected);
  const auth = { fixture: true };
  authenticate.mockResolvedValue(auth);
  await expect(guard.canActivate(context)).resolves.toBe(true);
  expect(authenticate).toHaveBeenCalledExactlyOnceWith(request.headers);
  expect(request.auth).toBe(auth);
});

it('propagates rejection without admitting the protected route', async () => {
  const { guard, context, authenticate, request } = fixture(Routes.prototype.protected);
  const error = new Error('Authentication rejected');
  authenticate.mockRejectedValue(error);
  await expect(guard.canActivate(context)).rejects.toBe(error);
  expect(request.auth).toBeUndefined();
});
