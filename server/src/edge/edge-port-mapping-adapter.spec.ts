import assert from 'node:assert/strict';
import { it } from 'vitest';
import { tryPromise } from 'src/utils/promise.js';

// Exercise the installed SDK's command construction without a router or discovery traffic.
const { InternetGatewayService4 } = await import(
  new URL('upnp/internet-gateway-service-4.js', import.meta.resolve('@achingbrain/nat-port-mapper')).href
);

for (const protocol of ['tcp', 'udp']) {
  it(`UPnP removes the assigned ${protocol.toUpperCase()} port with its original remote host`, async () => {
    const requests: Array<{ action: string; args: Array<[string, string | number]> }> = [];
    const device = {
      service: {
        uniqueServiceName: 'controlled-router',
        expires: Date.now() + 60_000,
        location: new URL('http://127.0.0.1:49152'),
      },
      run: (_service: string, action: string, args: Array<[string, string | number]>) =>
        tryPromise(() => {
          requests.push({ action, args });
          return { AddAnyPortMappingResponse: { NewReservedPort: 4443 } };
        }),
    };
    const gateway = new InternetGatewayService4(device, { autoRefresh: false });
    const result = await gateway.map(2443, '203.0.113.10', {
      externalPort: 3443,
      remoteHost: '198.51.100.20',
      protocol,
      autoRefresh: false,
    });
    assert.equal(result.externalPort, 4443);
    await gateway.unmap(2443);
    assert.deepEqual(
      requests.filter(({ action }) => action === 'DeletePortMapping'),
      [
        {
          action: 'DeletePortMapping',
          args: [
            ['NewRemoteHost', '198.51.100.20'],
            ['NewExternalPort', '4443'],
            ['NewProtocol', protocol.toUpperCase()],
          ],
        },
      ],
    );
  });
}
