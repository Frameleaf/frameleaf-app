#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSpk } = require('./build-spk.cjs');

const root = __dirname;
const digest = /^sha256:[a-f0-9]{64}$/;
const tag = /^frameleaf-v(\d+)\.(\d+)\.(\d+)-(\d+)$/;

function build(manifest, output) {
  assert(tag.test(manifest.tag), 'A stable Frameleaf release is required');
  assert(/^[a-f0-9]{40}$/.test(manifest.sourceCommit), 'Invalid source commit');
  assert(Array.isArray(manifest.migration.officialImmich) && manifest.migration.officialImmich.length,
    'NAS publication requires external Immich migration qualification');
  assert(Array.isArray(manifest.migration.priorFrameleaf) && manifest.migration.priorFrameleaf.length,
    'NAS publication requires prior Frameleaf migration qualification');
  const image = (name) => {
    const ref = manifest.images[name];
    assert(typeof ref === 'string' && digest.test(ref.split('@')[1]), `Invalid ${name} digest`);
    return ref;
  };
  const server = image('server');
  const ml = image('machineLearning');
  const postgres = image('postgres');
  const valkey = image('valkey');
  const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const write = (name, body) => {
    const target = path.join(output, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  const replacements = {
    '@RELEASE_TAG@': manifest.tag,
    '@SERVER_REF@': server,
    '@ML_REF@': ml,
    '@SERVER_TAG@': `${manifest.tag}@${server.split('@')[1]}`,
    '@ML_TAG@': `${manifest.tag}@${ml.split('@')[1]}`,
    '@PG_TAG@': postgres.split(':').slice(1).join(':'),
    '@VALKEY_TAG@': valkey.split(':').slice(1).join(':'),
  };
  for (const [suffix, placeholder] of [['cuda', '@ML_CUDA_TAG@'], ['rocm', '@ML_ROCM_TAG@'], ['openvino', '@ML_OPENVINO_TAG@']]) {
    const ref = manifest.images.machineLearningVariants?.[suffix];
    assert(ref && digest.test(ref.split('@')[1]), `Missing ${suffix} image`);
    replacements[placeholder] = `${manifest.tag}-${suffix}@${ref.split('@')[1]}`;
  }
  const render = (body) => {
    for (const [key, value] of Object.entries(replacements)) body = body.replaceAll(key, value);
    assert(!/@[A-Z_]+@/.test(body), 'Unresolved package placeholder');
    return body;
  };
  for (const name of ['frameleaf-server', 'frameleaf-ml']) {
    write(`unraid/templates/${name}.xml`, render(source(`unraid/${name}.xml.in`)));
  }
  write('unraid/ca_profile.xml', source('unraid/ca_profile.xml'));
  for (const name of ['app.yaml', 'ix_values.yaml', 'questions.yaml', 'templates/docker-compose.yaml', 'templates/test_values/basic-values.yaml']) {
    write(`truenas/ix-dev/community/frameleaf/${name}`, render(source(`truenas/${name}`)));
  }
  write('truenas/ix-dev/community/frameleaf/README.md',
    `Frameleaf ${manifest.tag}. Maintained by Frameleaf. Install on TrueNAS 24.10.2.2 or later.\n`);
  write('nas-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  buildSpk(manifest, path.join(output, 'synology'));
}

if (require.main === module) {
  assert(process.argv.length === 4, 'Usage: node build.cjs nas-manifest.json output-directory');
  build(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3]);
}
module.exports = { build };
