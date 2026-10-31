import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostInstallations, suggestedPort, LIBRARY_NAME_LABEL, MANAGER_DATA_LABEL } from '../src/compose.js';
import type { Container } from '../src/docker.js';

const container = (labels: Record<string, string>, ports: Record<string, string>, env: string[] = [], running = true) =>
  ({
    Id: Math.random().toString(16).slice(2),
    Name: '/c',
    Image: 'image',
    Config: { Labels: labels, Env: env },
    State: { Running: running },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: Object.fromEntries(Object.entries(ports).map(([inner, host]) => [inner, [{ HostIp: '', HostPort: host }]])),
    },
    Mounts: [],
    NetworkSettings: { Networks: {} },
  }) as unknown as Container;

const server = (id: string, port: string, extra: Record<string, string> = {}, running = true) =>
  container({ 'com.docker.compose.service': 'frameleaf-server', 'app.frameleaf.manager': id, ...extra }, { '2283/tcp': port }, [], running);

test('lists every library on the host and links each to the Manager that owns its state folder', () => {
  const containers = [
    container({ 'app.frameleaf.manager.role': 'controller' }, { '9443/tcp': '2282' }, ['MANAGER_DATA=/state/family']),
    container({ 'app.frameleaf.manager.role': 'controller' }, { '9443/tcp': '2284' }, ['MANAGER_DATA=/state/studio']),
    server('a'.repeat(12), '2283', { [LIBRARY_NAME_LABEL]: 'Family', [MANAGER_DATA_LABEL]: '/state/family' }),
    server('b'.repeat(12), '2285', { [LIBRARY_NAME_LABEL]: 'Studio', [MANAGER_DATA_LABEL]: '/state/studio' }),
    // Installed before the labels existed: listed, but without a Manager link.
    server('c'.repeat(12), '2287'),
    // A stopped leftover of the same library is not listed twice.
    server('b'.repeat(12), '2299', {}, false),
    // Containers without a valid Manager identity are ignored.
    server('not-an-id', '2290'),
  ];
  assert.deepEqual(hostInstallations(containers, 'a'.repeat(12), 'https://nas.local:2282'), [
    { name: 'Family', current: true, running: true, appPort: 2283, managerUrl: 'https://nas.local:2282' },
    { name: 'Studio', current: false, running: true, appPort: 2285, managerUrl: 'https://nas.local:2284' },
    { name: 'Frameleaf library', current: false, running: true, appPort: 2287, managerUrl: null },
  ]);
});

test('suggests the first port from 2283 that neither a container nor Manager uses', () => {
  assert.equal(suggestedPort([]), 2283);
  assert.equal(suggestedPort([server('a'.repeat(12), '2283')], [2284]), 2285);
});
