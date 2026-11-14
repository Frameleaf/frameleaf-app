const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { load } = require('js-yaml');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildManager } = require('./build-manager.cjs');
const { TYPE, IMAGE } = require('../../.github/verify-manager-release.cjs');

test('NAS Manager packages authenticate the component, both architectures and exact workflow before writing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-nas-'));
  const file = path.join(directory, 'manager-manifest.json');
  const sourceCommit = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
  const manifest = {
    schemaVersion: 1, component: 'frameleaf-manager', repository: 'Frameleaf/frameleaf-app',
    tag: 'manager-v0.1.0', sourceCommit, image: `${IMAGE}@${digest}`,
    buildRun: 'https://github.com/Frameleaf/frameleaf-app/actions/runs/123',
    architectures: ['amd64', 'arm64'].map(architecture => ({ architecture, sourceCommit,
      repository: 'Frameleaf/frameleaf-app', runId: '123', runAttempt: '1',
      digest, configDigest: digest, archiveSha256: 'c'.repeat(64), rootfsDiffIds: [digest], smoke: 'passed' })),
  };
  const build = { head_sha: sourceCommit, head_branch: 'main',
    head_repository: { full_name: 'Frameleaf/frameleaf-app' }, event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success', path: '.github/workflows/manager.yml', run_attempt: 1 };
  const run = (program, args) => {
    assert.equal(program, 'cosign');
    assert.equal(args.at(-1), manifest.image);
    if (args[0] === 'verify') return '[]';
    assert.equal(args[0], 'verify-attestation');
    return JSON.stringify({ payload: Buffer.from(JSON.stringify({ predicateType: TYPE,
      subject: [{ name: IMAGE, digest: { sha256: digest.slice(7) } }], predicate: manifest })).toString('base64') });
  };
  const request = async endpoint => { assert.equal(endpoint, 'actions/runs/123'); return build; };
  try {
    await fs.writeFile(file, JSON.stringify(manifest));
    const output = path.join(directory, 'valid');
    await buildManager(file, output, { run, request });
    manifest.installers = { schemaVersion: 1, sourceCommit, tag: manifest.tag, image: manifest.image,
      files: ['frameleaf-manager.xml', 'frameleaf-manager.compose.yaml', 'frameleaf-manager.hexos.json'].map(name => ({ name, sha256: '0'.repeat(64) })) };
    await fs.writeFile(file, JSON.stringify(manifest));
    const staleOutput = path.join(directory, 'stale-authenticated-templates');
    await assert.rejects(buildManager(file, staleOutput, { run, request }), /installer/i);
    await assert.rejects(fs.stat(staleOutput), { code: 'ENOENT' });
    delete manifest.installers;
    await fs.writeFile(file, JSON.stringify(manifest));
    const xml = await fs.readFile(path.join(output, 'unraid/templates/frameleaf-manager.xml'), 'utf8');
    assert(xml.includes('<Repository>ghcr.io/frameleaf/frameleaf-manager:latest</Repository>'));
    assert(xml.includes('MANAGER_PLATFORM'));
    assert(xml.includes('Target="/run/frameleaf-host/templates-user"'));
    assert(xml.includes('design/frameleaf/mark.png'));
    // Without it Manager publishes the Frameleaf app on 127.0.0.1 only, unreachable from other devices.
    assert(xml.includes('Target="MANAGER_BIND_ADDRESS" Default="0.0.0.0"'));
    // Unraid creates mapped folders as nobody:users; without these Manager cannot lock or chmod its state.
    assert(xml.includes('--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER</ExtraParams>'));
    assert(xml.includes('Target="/run/frameleaf-host/unraid-autostart" Default="" Mode="rw"'));
    assert(xml.includes('Target="MANAGER_UNRAID_AUTOSTART" Default=""'));
    assert(xml.includes('Leave blank: Manager automatically discovers'));
    assert(!xml.includes('Required for imports: select'));
    assert.equal(await fs.readFile(path.join(output, 'unraid/LICENSE'), 'utf8'),
      await fs.readFile(path.join(__dirname, '../../LICENSE'), 'utf8'));
    assert((await fs.readFile(path.join(output, 'unraid/README.md'), 'utf8')).includes('No claim key is needed'));
    assert(xml.includes('Target="MANAGER_ORIGIN" Default=""') && !/MANAGER_ORIGIN[^>]*Required="true"/.test(xml));
    execFileSync('python3', ['-c', `
import pathlib, re, sys, xml.etree.ElementTree as ET
root = pathlib.Path(sys.argv[1])
profile = ET.parse(root / 'ca_profile.xml').getroot()
assert profile.tag == 'CommunityApplications'
assert 'Manager' in profile.findtext('Profile', '')
assert profile.findtext('Forum') == 'https://frameleaf.app/help/community/'
assert profile.findtext('WebPage') == 'https://frameleaf.app'
assert profile.findtext('Discord') == 'https://discord.gg/NrQuxCMhh5'
assert profile.findtext('Twitter') == 'https://x.com/frameleafapp'
assert profile.findtext('Video') == 'https://www.youtube.com/watch?v=rNgyZZoZoEg'
assert profile.findtext('Photo') == 'https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/images/frameleaf-library.jpg'
assert profile.findtext('Reddit') == 'https://www.reddit.com/r/Frameleaf/'
assert profile.findtext('DonateLink') == 'https://frameleaf.app/pricing/#supporter'
assert profile.findtext('DonateText') == 'Support Frameleaf with a supporter licence'
assert profile.find('Facebook') is None
readme = (root / 'README.md').read_text()
assert '[Help center](https://frameleaf.app/help)' in readme
assert '[Documentation](https://frameleaf.app/docs)' in readme
templates = list((root / 'templates').glob('*.xml'))
assert len(templates) == 1
for template in templates:
    text = template.read_text()
    assert not re.search(r'@[A-Z_]+@', text)
    app = ET.fromstring(text)
    assert app.tag == 'Container' and app.get('version') == '2'
    for field in ['Name', 'Repository', 'Overview', 'Project', 'Support', 'Icon', 'TemplateURL']:
        assert app.findtext(field, '').strip(), field
    assert app.findtext('TemplateURL') == 'https://raw.githubusercontent.com/Frameleaf/unraid-apps/main/templates/' + template.name
    assert app.findtext('Repository') == 'ghcr.io/frameleaf/frameleaf-manager:latest'
    assert app.findtext('Privileged') == 'false'
    # Community Apps lists Frameleaf by this name and leads with the product tour.
    assert app.findtext('Name') == 'Frameleaf'
    assert [v.text for v in app.findall('Video')] == ['https://www.youtube.com/watch?v=' + v for v in ['rNgyZZoZoEg', 'INeVz9NFzOM', 'bTfFBDHc6OE']]
    assert len(app.findall('Screenshot')) == 9
    for config in app.findall('Config'):
        assert config.get('Description', '').strip(), config.get('Name')
`, path.join(output, 'unraid')]);
    const compose = load(await fs.readFile(path.join(output, 'truenas/frameleaf-manager.compose.yaml'), 'utf8'));
    assert.deepEqual(Object.keys(compose.services), ['manager']);
    assert.equal(compose.services.manager.image, 'ghcr.io/frameleaf/frameleaf-manager:latest');
    assert.equal(compose.services.manager.privileged, undefined);
    assert.deepEqual(compose.services.manager.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
    assert.equal(compose.services.manager.environment.MANAGER_BIND_ADDRESS, '0.0.0.0');
    // One value to edit: Manager finds the pools through /mnt and creates the folders chosen in setup.
    assert.deepEqual(Object.keys(compose.services.manager.environment).sort(), ['MANAGER_BIND_ADDRESS', 'MANAGER_DATA', 'MANAGER_PLATFORM']);
    assert.equal(compose.services.manager.environment.MANAGER_PLATFORM, 'truenas');
    assert.equal(compose.services.manager.environment.MANAGER_DATA, '/mnt/POOL_NAME/frameleaf/manager');
    assert.deepEqual(compose.services.manager.volumes.filter(bind => bind.source.startsWith('/mnt')),
      [{ type: 'bind', source: '/mnt', target: '/mnt', bind: { propagation: 'rslave', create_host_path: false } }]);
    assert(!compose.services.manager.volumes.some(bind => bind.target.startsWith('/var/lib/postgresql')));
    const hexos = JSON.parse(await fs.readFile(path.join(output, 'hexos/frameleaf-manager.hexos.json'), 'utf8'));
    assert.equal(hexos.custom, true);
    assert.deepEqual(hexos.app_values.image, { repository: IMAGE, tag: 'latest', pull_policy: 'missing' });
    assert.equal(hexos.metadata.version, '0.1.0');
    assert.equal(hexos.script.version, '0.1.0');
    assert.equal(hexos.app_values.privileged, undefined);
    assert.deepEqual(hexos.app_values.capabilities.add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
    assert.deepEqual(hexos.app_values.labels, [{ key: 'app.frameleaf.manager.role', value: 'controller' }]);
    assert.deepEqual(hexos.app_values.ports.map(port => [port.port_number, port.container_port]), [['$PORT(2282)', 9443]]);
    assert.equal(hexos.requirements.ports[0], 2282);
    const env = Object.fromEntries(hexos.app_values.envs.map(({ name, value }) => [name, value]));
    assert.equal(env.MANAGER_BIND_ADDRESS, '0.0.0.0');
    assert.equal(env.MANAGER_ORIGIN, undefined);
    const mounts = Object.fromEntries(hexos.app_values.storage.map(entry => [entry.mount_path, entry]));
    assert.equal(mounts['/var/run/docker.sock'].host_path_config.path, '/var/run/docker.sock');
    assert.equal(mounts['/run/frameleaf-host/mountinfo'].read_only, true);
    assert.equal(mounts['/run/frameleaf-host/mountinfo'].host_path_config.path, '/proc/1/mountinfo');
    // Manager compares host paths with its own view, so every library folder mounts at its host path.
    const folders = hexos.app_values.storage.filter(entry => entry.mount_path.startsWith('$LOCATION('));
    for (const entry of folders) assert.equal(entry.host_path_config.path, entry.mount_path);
    const roots = [env.MANAGER_DATA, env.MANAGER_BACKUP_ROOT, env.MANAGER_APPDATA_ROOT,
      ...env.MANAGER_STORAGE_ROOTS.split(':'), ...env.MANAGER_DATABASE_ROOTS.split(':')];
    for (const root of roots) assert(folders.some(entry => entry.mount_path === root), root);
    const created = hexos.ensure_directories_exists.map(entry => entry.path);
    for (const entry of folders) assert(created.includes(entry.mount_path), entry.mount_path);
    const text = JSON.stringify(hexos);
    for (const [, location] of text.matchAll(/\$LOCATION\((\w+)\)/g)) assert(hexos.requirements.locations.includes(location), location);
    // The catalog copy is the signed script with only the image tag pinned to this release.
    const custom = await fs.readFile(path.join(output, 'hexos/frameleaf-manager.hexos.json'), 'utf8');
    const catalog = await fs.readFile(path.join(output, 'hexos/frameleaf.json'), 'utf8');
    assert.equal(catalog, custom.replace('"tag": "latest"', '"tag": "manager-v0.1.0"'));
    assert.equal(JSON.parse(catalog).app_values.image.tag, 'manager-v0.1.0');
    assert.deepEqual(await fs.readdir(output), ['hexos', 'manager-manifest.json', 'truenas', 'unraid']);
    for (const head_branch of ['main']) {
      const admitted = path.join(directory, head_branch.replaceAll('/', '-'));
      await buildManager(file, admitted, { run, request: async () => ({ ...build, head_branch }) });
      assert.equal(JSON.parse(await fs.readFile(path.join(admitted, 'manager-manifest.json'), 'utf8')).image, manifest.image);
    }
    let count = 0;
    for (const mutation of [
      value => { value.image = `${IMAGE}:latest`; },
      value => { value.architectures.pop(); },
      value => { value.architectures[0].smoke = 'failed'; },
      value => { value.architectures[1].sourceCommit = 'd'.repeat(40); },
      value => { value.architectures[1].runAttempt = '2'; },
      value => { value.component = 'frameleaf-server'; },
      value => { value.tag = 'frameleaf-v3.1.0-1'; },
      value => { value.buildRun = 'https://github.com/other/repo/actions/runs/123'; },
    ]) {
      const changed = structuredClone(manifest); mutation(changed);
      await fs.writeFile(file, JSON.stringify(changed));
      const refused = path.join(directory, `refused-${count++}`);
      await assert.rejects(buildManager(file, refused, { run, request }));
      await assert.rejects(fs.stat(refused), { code: 'ENOENT' });
    }
    await fs.writeFile(file, JSON.stringify(manifest));
    for (const patch of [{ conclusion: 'failure' }, { path: '.github/workflows/cli.yml' },
      { head_sha: 'e'.repeat(40) }, { head_branch: 'aj/unreviewed' },
      { head_branch: 'aj/frameleaf-manager-release' }, { head_branch: 'master/frameleaf-implementation' },
      { head_repository: { full_name: 'other/frameleaf-app' } }, { run_attempt: 2 }]) {
      const refused = path.join(directory, `refused-${count++}`);
      await assert.rejects(buildManager(file, refused, { run, request: async () => ({ ...build, ...patch }) }));
      await assert.rejects(fs.stat(refused), { code: 'ENOENT' });
    }
    const refused = path.join(directory, 'unsigned');
    await assert.rejects(buildManager(file, refused, { run: () => { throw new Error('unsigned'); }, request }), /unsigned/);
    await assert.rejects(fs.stat(refused), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('launch.sh short form maps one folder; the long form still names each one', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'manager-launch-')));
  try {
    const bin = path.join(directory, 'bin'), log = path.join(directory, 'run'), dockerRoot = path.join(directory, 'docker');
    await fs.mkdir(bin); await fs.mkdir(dockerRoot);
    for (const [name, script] of [
      ['docker', `case "$1" in info) echo "${dockerRoot}";; image) echo "${IMAGE}@sha256:abc";; run) printf '%s\\n' "$@" > "${log}";; esac`],
      ['findmnt', 'case "$*" in *FSTYPE*) echo ext4;; *) echo /dev/sda1;; esac'],
      ['cosign', 'exit 0'],
    ]) await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    const launch = args => spawnSync('sh', [path.join(__dirname, '../../manager/launch.sh'), `${IMAGE}:latest`, ...args],
      { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });

    const root = path.join(directory, 'library', 'frameleaf');
    assert.equal(launch(['https://nas.local:2282', root]).status, 0);
    let run = (await fs.readFile(log, 'utf8')).split('\n');
    assert((await fs.stat(path.join(root, 'manager'))).isDirectory());
    for (const arg of [`type=bind,source=${root},target=${root}`, `MANAGER_FOLDER_ROOT=${root}`, `MANAGER_DATA=${root}/manager`, 'MANAGER_ORIGIN=https://nas.local:2282'])
      assert(run.includes(arg), arg);
    assert(!run.some(arg => arg.startsWith('MANAGER_STORAGE_ROOTS=')));

    const folders = ['state', 'media', 'backups', 'appdata'].map(name => path.join(directory, name));
    await Promise.all(folders.map(folder => fs.mkdir(folder)));
    assert.equal(launch([...folders.slice(0, 3), 'https://nas.local:2282', folders[3]]).status, 0);
    run = (await fs.readFile(log, 'utf8')).split('\n');
    assert(run.includes(`MANAGER_STORAGE_ROOTS=${folders[1]}`));
    assert(run.includes(`MANAGER_BACKUP_ROOT=${folders[2]}`));
    assert(!run.some(arg => arg.startsWith('MANAGER_FOLDER_ROOT=')));

    assert.equal(launch(['/not/an/origin', root]).status, 2);
    assert.equal(launch(['https://nas.local:2282', '/frameleaf']).status, 2);
    assert.equal(launch(['https://nas.local:2282', '/frameleaf/']).status, 2);
    assert.equal(launch(['https://nas.local:2282', '//frameleaf']).status, 2);
    assert.equal(launch(['https://nas.local:2282', `${root}/`]).status, 0);
    run = (await fs.readFile(log, 'utf8')).split('\n');
    assert(run.includes(`MANAGER_FOLDER_ROOT=${root}`) && run.includes(`MANAGER_DATA=${root}/manager`));

    // MANAGER_EXTRA_FOLDERS adds drives to the short form, each mapped at its own path.
    const ssd = path.join(directory, 'ssd', 'frameleaf'), disk2 = path.join(directory, 'disk 2', 'frameleaf');
    await fs.mkdir(ssd, { recursive: true }); await fs.mkdir(disk2, { recursive: true });
    await fs.symlink(path.dirname(ssd), path.join(directory, 'link'));
    const extra = (folders, args = ['https://nas.local:2282', root]) => spawnSync('sh', [path.join(__dirname, '../../manager/launch.sh'), `${IMAGE}:latest`, ...args],
      { env: { PATH: `${bin}:/usr/bin:/bin`, MANAGER_EXTRA_FOLDERS: folders }, encoding: 'utf8' });
    await fs.rm(log);
    assert.equal(extra(`${ssd}:${disk2}/`).status, 0);
    run = (await fs.readFile(log, 'utf8')).split('\n');
    assert(run.includes(`MANAGER_FOLDER_ROOT=${root}:${ssd}:${disk2}`));
    assert(run.includes(`MANAGER_DATA=${root}/manager`));
    for (const folder of [root, ssd, disk2]) assert(run.includes(`type=bind,source=${folder},target=${folder}`), folder);
    // An empty value is the one-folder form, unchanged.
    assert.equal(extra('').status, 0);
    assert((await fs.readFile(log, 'utf8')).split('\n').includes(`MANAGER_FOLDER_ROOT=${root}`));
    await fs.rm(log);
    for (const folders of [
      '/', '/frameleaf', 'relative/path', `${ssd}::${disk2}`, // never / or one level, and no empty entries
      path.join(directory, 'missing', 'drive'), // a drive that isn't there is never created
      `${ssd}:${ssd}`, path.join(root, 'inside'), path.dirname(root), `${ssd}:${path.join(ssd, 'x')}`, // overlapping folders
      path.join(directory, 'link', 'frameleaf'), // canonical paths only, never a link
    ]) {
      const result = extra(folders);
      assert.equal(result.status, 2, `${folders}: ${result.stderr}`);
    }
    // The long form names every folder; extra drives belong to the short form.
    assert.equal(extra(ssd, [...folders.slice(0, 3), 'https://nas.local:2282', folders[3]]).status, 2);
    await assert.rejects(fs.stat(log), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(directory, 'missing')), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
