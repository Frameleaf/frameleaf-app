// Image build/package gate. Does not render media or download inputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const revision = '03179f8e080aa9cedebfe14b098b7ba88940a292';
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifestPath = (prefix) => join(prefix, 'share/frameleaf/native-darktable.json');
function files(path) {
  return readdirSync(path)
    .sort()
    .flatMap((name) => {
      const file = join(path, name);
      return statSync(file).isDirectory() ? files(file) : [file];
    });
}
export function recordNativePackage(prefix, pins) {
  const resources = [
    'bin/darktable',
    'bin/darktable-cli',
    'lib/darktable',
    'share/darktable',
    'share/lensfun/version_1',
    'share/frameleaf/licenses',
  ].flatMap((name) => (statSync(join(prefix, name)).isDirectory() ? files(join(prefix, name)) : [join(prefix, name)]));
  const lenses = readdirSync(join(prefix, 'lib')).filter((name) => /^liblensfun\.so/.test(name));
  assert.ok(lenses.length, 'Pinned Lensfun library is absent');
  resources.push(...lenses.map((name) => join(prefix, 'lib', name)));
  const manifest = {
    version: 1,
    source: pins,
    files: Object.fromEntries(resources.map((file) => [file.slice(prefix.length + 1), hash(file)])),
  };
  writeFileSync(manifestPath(prefix), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
export function verifyNativeFiles(prefix) {
  const manifest = JSON.parse(readFileSync(manifestPath(prefix), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.source.revision, revision);
  assert.equal(manifest.source.version, '5.6.1');
  assert.equal(Object.keys(manifest.source.patches).length, 2);
  for (const name of ['patch-darktable-lens.py', 'patch-darktable-mask-geometry.py'])
    assert.match(manifest.source.patches[name], /^[a-f0-9]{64}$/);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), 'Package manifest path escapes prefix');
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(hash(join(prefix, name)), expected, `Native package changed: ${name}`);
  }
  for (const name of [
    'bin/darktable-cli',
    'lib/darktable/plugins/liblens.so',
    'lib/darktable/plugins/librotatepixels.so',
    'share/darktable/darktablerc',
    'share/darktable/noiseprofiles.json',
    'share/darktable/rawspeed/cameras.xml',
  ])
    assert.ok(manifest.files[name], `Native runtime resource is absent: ${name}`);
  assert.ok(
    Object.keys(manifest.files).some((name) => /^share\/lensfun\/version_1\/.*\.xml$/.test(name)),
    'Lens database is absent',
  );
  assert.ok(
    readFileSync(join(prefix, 'lib/darktable/plugins/liblens.so')).includes(Buffer.from('frameleaf-lens-calibration:')),
  );
  assert.ok(
    readFileSync(join(prefix, 'lib/darktable/plugins/librotatepixels.so')).includes(
      Buffer.from('frameleaf-native-mask-geometry:rotatepixels:1'),
    ),
  );
  return manifest;
}
export function verifyNativeRuntime(prefix, recordPath, packageListPath) {
  const manifest = verifyNativeFiles(prefix);
  assert.match(
    execFileSync(join(prefix, 'bin/darktable-cli'), ['--version'], { encoding: 'utf8', timeout: 15000 }),
    /darktable(?:-cli)?\s+5\.6\.1(?:\s|$)/i,
  );
  const dependencies = {};
  for (const name of Object.keys(manifest.files)) {
    const file = join(prefix, name);
    if (
      !readFileSync(file)
        .subarray(0, 4)
        .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
      continue;
    const linkage = execFileSync('ldd', [file], { encoding: 'utf8', timeout: 15000 });
    assert.doesNotMatch(linkage, /not found/, `Missing native linkage: ${name}`);
    for (const match of linkage.matchAll(/(?:=>\s+)?(\/[^\s]+)\s+\(/g)) dependencies[match[1]] = hash(match[1]);
  }
  assert.ok(
    Object.keys(dependencies).some((name) => /^\/usr\/local\/lib\/liblensfun\.so/.test(name)),
    'Native engine did not link pinned Lensfun',
  );
  assert.ok(
    Object.keys(dependencies).some((name) => /^\/usr\/local\/lib\/libraw\.so/.test(name)),
    'Native engine did not link pinned LibRaw',
  );
  if (packageListPath) {
    const packages = new Set();
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('/usr/local/')) continue;
      const real = realpathSync(name);
      let owner;
      for (const candidate of [real, real.replace(/^\/usr\/(lib|lib64)\//, '/$1/')]) {
        try {
          owner = execFileSync('dpkg-query', ['-S', candidate], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
            .split('\n')[0]
            .split(': ')[0];
          break;
        } catch {}
      }
      assert.ok(owner, `Native runtime dependency has no recorded package: ${name}`);
      const version = execFileSync('dpkg-query', ['-W', '-f=${Version}', owner], { encoding: 'utf8' });
      packages.add(`${owner}=${version}`);
    }
    writeFileSync(packageListPath, [...packages].sort().join('\n') + '\n');
  }
  if (recordPath)
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          dependencies,
          packages: execFileSync('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n'], { encoding: 'utf8' }),
        },
        null,
        2,
      ) + '\n',
    );
  else {
    const savedPath = '/build/darktable-runtime.json';
    if (existsSync(savedPath)) {
      const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
      assert.deepEqual(dependencies, saved.dependencies, 'Native dependency artifact changed');
    }
  }
  console.log('Native darktable package gate passed: source, both patches, files, resources, version and linkage');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, prefix = '/usr/local', argument, packageListPath] = process.argv.slice(2);
  if (command === 'record') recordNativePackage(prefix, JSON.parse(readFileSync(argument, 'utf8')));
  else if (command === 'verify') verifyNativeRuntime(prefix, argument, packageListPath);
  else throw new Error('Use record <prefix> <pins.json> or verify <prefix> [dependency-record.json]');
}
