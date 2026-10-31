import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dockermanTemplate, saveDockermanTemplates } from '../src/dockerman.js';

const project = 'frameleaf-aaaaaaaaaaaa';
function fixture() {
  return {
    Name: `/${project}-database-1`,
    Config: { Image: 'ghcr.io/frameleaf/frameleaf-postgres@sha256:' + 'a'.repeat(64),
      Env: ["POSTGRES_PASSWORD=a$`command`'&<\"", 'POSTGRES_DB=frameleaf'],
      Labels: { 'app.frameleaf.manager': 'aaaaaaaaaaaa', 'com.docker.compose.project': project,
        'com.docker.compose.service': 'database', 'com.docker.compose.config-hash': 'original' },
      Healthcheck: { Test: ['CMD-SHELL', 'pg_isready -U frameleaf'], Interval: 5000000000, Timeout: 5000000000, Retries: 60 },
      StopTimeout: 60 },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, ShmSize: 134217728,
      Devices: [{ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' }],
      DeviceCgroupRules: ['c 189:* rmw'], GroupAdd: ['video'],
      PortBindings: { '2283/tcp': [{ HostIp: '127.0.0.1', HostPort: '2283' }] } },
    Mounts: [{ Type: 'bind', Source: '/appdata/postgres', Destination: '/var/lib/postgresql', RW: true },
      { Type: 'volume', Name: `${project}_model-cache`, Destination: '/cache', RW: false }],
    NetworkSettings: { Networks: { [`${project}_default`]: { Aliases: ['database', 'original-name'] } } },
  };
}

test('DockerMan templates preserve identity, secrets, storage, devices, networking and health checks', () => {
  const xml = dockermanTemplate(fixture());
  for (const value of [project + '-database-1', 'com.docker.compose.config-hash', 'original',
    'POSTGRES_PASSWORD', '/appdata/postgres',
    `${project}_model-cache`, 'readonly', '--network-alias', 'database', '--health-cmd',
    '--health-retries', '5000000000ns', '--shm-size', '--stop-timeout', '--device', '/dev/dri',
    '--device-cgroup-rule', '--group-add', '127.0.0.1:2283:2283/tcp']) assert.ok(xml.includes(value), value);
  assert.ok(xml.includes('mark.png'));
  assert.ok(!xml.includes('frameleaf-app-icon.svg'));
  const parsed = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,html,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.read()); print(json.dumps({"extra":html.unescape(r.findtext("ExtraParams")),"env":{c.get("Target"):html.unescape(c.text) for c in r.findall("Config")}}))'], { input: xml, encoding: 'utf8' }));
  assert.equal(parsed.env.POSTGRES_PASSWORD, fixture().Config.Env[0].slice('POSTGRES_PASSWORD='.length));
  const args = execFileSync('sh', ['-c', `printf '%s\\n' ${parsed.extra}`], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(args.includes('--label=com.docker.compose.config-hash=original'));
  assert.ok(args.includes('--health-cmd=pg_isready -U frameleaf'));
  assert.ok(args.includes('--device=/dev/dri:/dev/dri:rwm'));
});

test('DockerMan entity decoding and whitespace normalization cannot change mounts or credentials', () => {
  const container = fixture();
  container.Mounts[0].Source = '/appdata/family  &amp; photos';
  container.Config.Env = ['POSTGRES_PASSWORD=one  two\r\n&amp;'];
  const parsed = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,html,re,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.read()); print(json.dumps(re.sub(r"\\s\\s+", " ", html.unescape(r.findtext("ExtraParams")))))'], { input: dockermanTemplate(container), encoding: 'utf8' }));
  const args = execFileSync('sh', ['-c', `printf '%s\\0' ${parsed}`], { encoding: 'utf8' }).split('\0');
  assert.ok(args.includes('--mount=type=bind,source=/appdata/family  &amp; photos,target=/var/lib/postgresql'));
  assert.ok(args.includes('--env=POSTGRES_PASSWORD=one  two\r\n&amp;'));
});

test('NVIDIA reservations and disabled healthchecks survive DockerMan recreation', () => {
  const container = fixture() as any;
  container.HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: 1, DeviceIDs: null, Capabilities: [['gpu']] }];
  container.Config.Healthcheck = { Test: ['NONE'] };
  const xml = dockermanTemplate(container);
  assert.ok(xml.includes('driver=nvidia,count=1,"capabilities=gpu"'));
  assert.ok(xml.includes('--no-healthcheck'));
});

test('multiple networks use DockerMan-recognisable options with their own aliases', () => {
  const container = fixture();
  container.NetworkSettings.Networks['source-net'] = { Aliases: ['import-source'] };
  const xml = dockermanTemplate(container);
  assert.ok(xml.includes(`--network=name=${project}_default,alias=database,alias=original-name`));
  assert.ok(xml.includes('--network=name=source-net,alias=import-source'));
  container.NetworkSettings.Networks['source-net'].Aliases = ['unsafe,option'];
  assert.throws(() => dockermanTemplate(container), /dockerman_unsupported_network_alias/);
});

test('only this managed project can be exported, with private atomic template files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dockerman-'));
  try {
    await saveDockermanTemplates([fixture()], project, directory);
    const path = join(directory, `my-${project}-database-1.xml`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, 'utf8'), dockermanTemplate(fixture()));
    const other = fixture();
    other.Config.Labels['app.frameleaf.manager'] = 'bbbbbbbbbbbb';
    await assert.rejects(saveDockermanTemplates([other], project, directory), /dockerman_container_identity/);
    const lan = fixture();
    lan.Name = `/${project}-frameleaf-lan-discovery-1`;
    lan.Config.Labels['com.docker.compose.service'] = 'frameleaf-lan-discovery';
    await saveDockermanTemplates([fixture(), lan], project, directory);
    await assert.rejects(stat(join(directory, `my-${project}-frameleaf-lan-discovery-1.xml`)), { code: 'ENOENT' });
    await saveDockermanTemplates([], project, directory);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await assert.rejects(saveDockermanTemplates([], '../../outside', directory), /dockerman_container_identity/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
