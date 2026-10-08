const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyManagerRelease } = require('../../.github/verify-manager-release.cjs');

async function buildManager(file, output, verification = {}) {
  const manifest = await verifyManagerRelease(file, verification);
  const write = (name, body) => {
    const target = path.join(output, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  for (const [source, destination] of [
    ['unraid/frameleaf-manager.xml.in', 'unraid/templates/frameleaf-manager.xml'],
    ['truenas/manager.compose.yaml.in', 'truenas/frameleaf-manager.compose.yaml'],
  ]) {
    const body = fs.readFileSync(path.join(__dirname, source), 'utf8').replaceAll('@MANAGER_REF@', manifest.image);
    assert(!/@[A-Z_]+@/.test(body), 'Unresolved Manager package placeholder');
    write(destination, body);
  }
  for (const name of ['ca_profile.xml', 'README.md'])
    write(`unraid/${name}`, fs.readFileSync(path.join(__dirname, 'unraid', name), 'utf8'));
  write('unraid/LICENSE', fs.readFileSync(path.join(__dirname, '../../LICENSE'), 'utf8'));
  write('manager-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
}
module.exports = { buildManager };
if (require.main === module) {
  assert(process.argv.length === 4, 'Usage: node build-manager.cjs manager-manifest.json output-directory');
  buildManager(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
