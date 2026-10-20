import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanDiscoveryBridge } from '../bin/frameleaf-lan-discovery.mjs';

const ping = {
  res: 'pong',
  id: 'bd0bd1b4-ac2b-494d-afb7-2914f0e23fc3',
  name: 'Home',
  linked: false,
  setup: 'needed',
  cloud: 'available',
  lanDiscovery: true,
};
function harness() {
  const records = [];
  let stopped = 0,
    destroyed = 0;
  const publisher = {
    publish(record) {
      records.push(record);
      return {
        stop() {
          stopped++;
        },
      };
    },
    unpublishAll(done) {
      done();
    },
    destroy() {
      destroyed++;
    },
  };
  let body = ping,
    ok = true;
  const bridge = new LanDiscoveryBridge(publisher, 'http://127.0.0.1:2290', async () => ({
    ok,
    json: async () => body,
  }));
  return {
    bridge,
    records,
    stopped: () => stopped,
    destroyed: () => destroyed,
    set(value, healthy = true) {
      body = value;
      ok = healthy;
    },
  };
}
test('advertises the published host port and tracks identity and setup changes', async () => {
  const h = harness();
  await h.bridge.refresh();
  assert.equal(h.records[0].port, 2290);
  assert.equal(h.records[0].type, 'frameleaf');
  assert.deepEqual(h.records[0].txt, {
    id: ping.id,
    name: 'Home',
    linked: 'false',
    setup: 'needed',
    cloud: 'available',
    scheme: 'http',
  });
  await h.bridge.refresh();
  assert.equal(h.records.length, 1);
  h.set({ ...ping, name: 'Linked home', linked: true, setup: 'complete' });
  await h.bridge.refresh();
  assert.equal(h.stopped(), 1);
  assert.equal(h.records[1].txt.linked, 'true');
  h.bridge.stop();
  assert.equal(h.destroyed(), 1);
});
test('withdraws when disabled, offline, or metadata is malformed; healthy retries recover', async () => {
  for (const body of [
    { ...ping, lanDiscovery: false },
    { ...ping, id: '' },
    { ...ping, linked: 'true' },
    { ...ping, setup: 'bad' },
    {},
    null,
  ]) {
    const h = harness();
    await h.bridge.refresh();
    h.set(body);
    await h.bridge.refresh();
    assert.equal(h.stopped(), 1);
    assert.equal(h.records.length, 1);
    h.set(ping);
    await h.bridge.refresh();
    assert.equal(h.records.length, 2);
    h.set(ping, false);
    await h.bridge.refresh();
    assert.equal(h.stopped(), 2);
    h.bridge.stop();
  }
});
test('an in-flight response cannot republish after shutdown', async () => {
  let finish;
  const bridge = new LanDiscoveryBridge(
    {
      publish() {
        assert.fail('published after shutdown');
      },
      unpublishAll(done) {
        done();
      },
      destroy() {},
    },
    'http://127.0.0.1:2283',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = bridge.refresh();
  bridge.stop();
  finish({ ok: true, json: async () => ping });
  await pending;
});
test('published address records exclude Docker bridge and unrelated interfaces', async () => {
  let service;
  const publisher = {
    publish() {
      service = {
        stop() {},
        records() {
          return [
            { type: 'SRV', data: {} },
            { type: 'A', data: '192.168.96.4' },
            { type: 'A', data: '192.168.0.58' },
            { type: 'AAAA', data: 'fd00::1' },
          ];
        },
      };
      return service;
    },
    unpublishAll(done) {
      done();
    },
    destroy() {},
  };
  const bridge = new LanDiscoveryBridge(
    publisher,
    'http://127.0.0.1:2283',
    async () => ({ ok: true, json: async () => ping }),
    async () => '192.168.0.58',
  );
  await bridge.refresh();
  assert.deepEqual(
    service.records().filter((r) => r.type === 'A' || r.type === 'AAAA'),
    [{ type: 'A', data: '192.168.0.58' }],
  );
  bridge.stop();
});
