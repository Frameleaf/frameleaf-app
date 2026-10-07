#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyBundle, verifyNasManifest } = require('../../.github/verify-release-bundle.cjs');

const root = __dirname;
const digest = /^sha256:[a-f0-9]{64}$/;
const tag = /^frameleaf-v(\d+)\.(\d+)\.(\d+)-(\d+)$/;

async function build(directory, expectedTag, output, verification = {}) {
  assert(tag.test(expectedTag), 'A stable Frameleaf release is required');
  const release = await verifyBundle(directory, expectedTag, { ...verification, authenticate: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'nas-manifest.json'), 'utf8'));
  verifyNasManifest(manifest, release);
  const image = (name) => {
    const ref = manifest.images[name];
    assert(typeof ref === 'string' && digest.test(ref.split('@')[1]), `Invalid ${name} digest`);
    return ref;
  };
  const server = image('server');
  const ml = image('machineLearning');
  const postgres = image('postgres');
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
    '@PG_REPOSITORY@': postgres.split('@')[0].split(':')[0],
    '@PG_TAG@': `${postgres.split('@')[0].split(':')[1] || '19beta4-pgvector0.8.7'}@${postgres.split('@')[1]}`,
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
}

if (require.main === module) {
  assert(process.argv.length === 5, 'Usage: node build.cjs release-directory release-tag output-directory');
  build(process.argv[2], process.argv[3], process.argv[4]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { build };
