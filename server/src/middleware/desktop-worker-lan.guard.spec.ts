import type { ExecutionContext } from '@nestjs/common';
import { DesktopWorkerLanGuard } from 'src/middleware/desktop-worker-lan.guard.js';

const guard = (trustedLanCidrs: string[] = []) =>
  new DesktopWorkerLanGuard({
    getEnv: () => ({ frameleafCloud: { trustedLanCidrs } }),
  } as never);
const context = (ip?: string, via?: string, headers = {}) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ ip, frameleafVia: via, headers }) }),
  }) as unknown as ExecutionContext;

it.each(['192.168.1.20', '::1', '127.0.0.1'])('allows direct home traffic from %s', (ip) => {
  expect(guard().canActivate(context(ip))).toBe(true);
});
it('allows a verified LAN edge arrival and explicitly trusted private overlay', () => {
  expect(guard().canActivate(context('203.0.113.4', 'lan'))).toBe(true);
  expect(guard(['100.64.0.0/10']).canActivate(context('100.64.2.3'))).toBe(true);
});
it.each(['wan', 'relay'])('refuses verified %s even with a loopback proxy socket', (via) => {
  expect(() => guard().canActivate(context('127.0.0.1', via))).toThrow('desktop_worker_lan_required');
});
it.each([undefined, '203.0.113.4', '100.64.2.3'])('refuses unknown/off-network %s and client LAN headers', (ip) => {
  expect(() => guard().canActivate(context(ip, undefined, { 'x-frameleaf-via': 'lan' }))).toThrow(
    'desktop_worker_lan_required',
  );
});
