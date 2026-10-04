const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = path.join(__dirname, 'synology');
function buildSpk(manifest, output) {
  const match = /^frameleaf-v(\d+)\.(\d+)\.(\d+)-(\d+)$/.exec(manifest.tag);
  assert(match, 'DSM package requires a stable Frameleaf release');
  const version = `${match[1]}.${match[2]}.${match[3]}-${match[4]}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'frameleaf-spk-'));
  try {
    const stage = path.join(temp, 'stage');
    const payload = path.join(temp, 'payload');
    fs.mkdirSync(path.join(payload, 'project'), { recursive: true });
    fs.mkdirSync(stage);
    for (const folder of ['scripts', 'conf', 'WIZARD_UIFILES']) {
      fs.cpSync(path.join(source, folder), path.join(stage, folder), { recursive: true });
    }
    for (const name of ['PACKAGE_ICON.PNG', 'PACKAGE_ICON_256.PNG']) {
      fs.copyFileSync(path.join(source, name), path.join(stage, name));
    }
    fs.copyFileSync(path.join(__dirname, '../../LICENSE'), path.join(stage, 'LICENSE'));
    fs.writeFileSync(path.join(stage, 'INFO'), fs.readFileSync(path.join(source, 'INFO.in'), 'utf8').replace('@DSM_VERSION@', version));
    let compose = fs.readFileSync(path.join(source, 'project/compose.yaml.in'), 'utf8');
    for (const [key, value] of Object.entries({
      '@SERVER_REF@': manifest.images.server,
      '@ML_REF@': manifest.images.machineLearning,
      '@PG_REF@': manifest.images.postgres,
      '@VALKEY_REF@': manifest.images.valkey,
    })) compose = compose.replaceAll(key, value);
    assert(!/@[A-Z_]+@/.test(compose), 'Unresolved Synology image');
    fs.writeFileSync(path.join(payload, 'project/compose.yaml'), compose);
    fs.writeFileSync(path.join(payload, 'project/nas-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    execFileSync('tar', ['-czf', path.join(stage, 'package.tgz'), '-C', payload, '.']);
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, `Frameleaf-noarch-${version}.spk`);
    execFileSync('tar', ['-cf', file, '-C', stage, 'INFO', 'package.tgz', 'scripts', 'conf', 'WIZARD_UIFILES', 'LICENSE', 'PACKAGE_ICON.PNG', 'PACKAGE_ICON_256.PNG']);
    return file;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { buildSpk };
