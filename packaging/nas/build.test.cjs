const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('./build.cjs');

const sha = (n) => `sha256:${String(n).repeat(64)}`;
const manifest = {
  tag: 'frameleaf-v3.1.0-1', sourceCommit: 'a'.repeat(40),
  migration: { officialImmich: ['v3.1.0'], priorFrameleaf: ['frameleaf-v3.1.0-0'] },
  images: {
    server: `ghcr.io/frameleaf/frameleaf-server@${sha(1)}`,
    machineLearning: `ghcr.io/frameleaf/frameleaf-machine-learning@${sha(2)}`,
    postgres: `ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@${sha(3)}`,
    valkey: `docker.io/valkey/valkey:9@${sha(4)}`,
    machineLearningVariants: Object.fromEntries(['cuda', 'rocm', 'openvino'].map((name, i) => [name, `ghcr.io/frameleaf/frameleaf-machine-learning@${sha(i + 5)}`])),
  },
};
test('release package render pins every image and rejects unqualified migration', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'frameleaf-nas-'));
  try {
    assert.throws(() => build({ ...manifest, migration: { officialImmich: [] } }, out), /migration qualification/);
    assert.throws(() => build({ ...manifest, migration: { officialImmich: ['v3.1.0'], priorFrameleaf: [] } }, out), /Frameleaf migration qualification/);
    build(manifest, out);
    const read = (name) => fs.readFileSync(path.join(out, name), 'utf8');
    assert(read('unraid/templates/frameleaf-server.xml').includes(manifest.images.server));
    assert(read('unraid/templates/frameleaf-ml.xml').includes(manifest.images.machineLearning));
    assert(read('unraid/ca_profile.xml').includes('<Profile>'));
    const values = read('truenas/ix-dev/community/frameleaf/ix_values.yaml');
    assert(values.includes(`frameleaf-v3.1.0-1@${sha(1)}`));
    assert(values.includes(`14-vectorchord0.4.3-pgvectors0.2.0@${sha(3)}`));
    assert(!values.includes('@SERVER_TAG@'));
    const spk = fs.readdirSync(path.join(out, 'synology'));
    assert.deepEqual(spk, ['Frameleaf-noarch-3.1.0-1.spk']);
    const unpack = path.join(out, 'unpack');
    fs.mkdirSync(unpack);
    execFileSync('tar', ['-xf', path.join(out, 'synology', spk[0]), '-C', unpack]);
    execFileSync('tar', ['-xzf', path.join(unpack, 'package.tgz'), '-C', unpack]);
    assert.equal(fs.readlinkSync(path.join(unpack, 'project/.env')), '/var/packages/Frameleaf/var/frameleaf.env');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
