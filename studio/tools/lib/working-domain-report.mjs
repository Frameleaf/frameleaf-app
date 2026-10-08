import assert from 'node:assert/strict';
import { HDR_BLURS } from '../blur-reference.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inventory, admitAdaptedSource } from '../engine.mjs';

export const WORKING_DOMAINS = {
  sdr: { id: 'srgb-display-bt709', primaries: 'bt709', encoding: 'srgb', alpha: 'straight' },
  hdr: { id: 'linear-display-bt709-v1', primaries: 'bt709', encoding: 'linear-display', alpha: 'straight', referenceWhiteNits: 203 },
};
export const REPORT_BINDINGS = ['studio/tools/lib/working-domain-report.mjs', 'studio/tools/lib/cross-browser-harness.mjs',
  'studio/tools/lib/browser-driver.mjs', 'studio/tools/photometric-goldens.mjs',
  'studio/tools/hdr-master.mjs', 'studio/tools/blur-reference.mjs', 'studio/tools/pixelate-reference.mjs', 'studio/tools/geometry-reference.mjs', 'studio/tools/hdr-source-validation.mjs',
  'studio/effect-hdr-semantics.json', 'studio/transition-semantics.json'];
const root = new URL('../../../', import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Verify the actual prepared inputs, including patch bytes, rather than copying a manifest claim.
export async function testedSource(runner) {
  const build = JSON.parse(await readFile(new URL('studio/engine-build.json', root)));
  const manifest = JSON.parse(await readFile(new URL('studio/freecut-feature-manifest.json', root)));
  const files = await inventory(fileURLToPath(new URL('studio/engine/', root)), '',
    new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']));
  await admitAdaptedSource(files, build.sourceSha256);
  for (const patch of build.patches) assert.equal(hash(await readFile(new URL(`studio/${patch.path}`, root))), patch.sha256);
  const runnerPath = fileURLToPath(runner).slice(fileURLToPath(root).length);
  const bindings = await Promise.all(REPORT_BINDINGS.map(async (path) => ({ path, sha256: hash(await readFile(new URL(path, root))) })));
  return { engineRevision: manifest.engineRevision, sourceSha256: build.sourceSha256, patches: build.patches,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runner: { path: runnerPath, sha256: hash(await readFile(runner)) }, bindings };
}

// These are the actual routes the matrix runners measure, shared by production
// report construction and admission. Observation labels cannot change a route's domain.
export function domainObservations(report) {
  const family = report.source.runner.path.match(/\/(effects|blend|transition)-matrix\.browser\.mjs$/)?.[1];
  assert(family, 'known matrix runner required');
  const observations = [];
  const oracle = family === 'effects' ? 'pinned SDR parity, parameter meaning, resolver and stack assertions' :
    family === 'blend' ? 'independent pinned SDR blend equations and production case assertions' :
    'pinned SDR endpoints, directions, parity and production case assertions';
  const add = (id, name, workingDomain, witness, expected = 'rendered') => {
    if (!witness.split('.').reduce((value, key) => value?.[key], report)) return;
    observations.push({ fixtureId: `${family === 'effects' ? 'effect' : family}.${id}/apply/${name}`,
      workingDomain, expected, observed: expected, result: 'passed', witness,
      oracle: workingDomain === WORKING_DOMAINS.sdr ? oracle : expected === 'rendered' ?
        (family === 'effects' ? 'independent linear tone equations and premultiplied spatial-kernel equations, parameter limits, resolver, alpha and stack assertions' :
          'independent linear straight-alpha source-over equation') : 'actual registered operator throws shared HdrRenderUnavailableError' });
  };
  const rows = family === 'effects' ? report.effects : family === 'blend' ? report.results : report.transitions;
  assert(Array.isArray(rows), 'matrix measurement rows required');
  rows.forEach((row, index) => {
    const id = family === 'blend' ? row.mode : row.id;
    assert(typeof id === 'string' && id, 'measured operator identity required');
    if (family === 'effects') {
      for (const [name, route] of [['normal', 'cases.0'], ['extreme', 'cases'], ['animated', 'animation'], ['composed', 'stack'], ['invalid', 'invalid']])
        add(id, name, WORKING_DOMAINS.sdr, `effects.${index}.${route}`);
      if (['gpu-brightness', 'gpu-contrast', 'gpu-exposure', 'gpu-saturation', 'gpu-temperature', 'gpu-vibrance', 'gpu-grayscale', 'gpu-sepia', 'gpu-invert', 'gpu-pixelate', 'gpu-twirl', 'gpu-wave', 'gpu-bulge'].includes(id) || HDR_BLURS.includes(id)) {
        for (const [name, route] of [['normal', 'cases.0'], ['extreme', 'cases'], ['animated', 'animation'], ['composed', 'stack'], ['invalid', 'invalid']])
          add(id, name, WORKING_DOMAINS.hdr, `effects.${index}.${row.hdr ? 'hdr' : row.hdrAffine ? 'hdrAffine' : 'hdrSpatial'}.${row.hdrAffine && id === 'gpu-invert' && name === 'invalid' ? 'extra' : route}`);
      } else add(id, 'extreme', WORKING_DOMAINS.hdr, `effects.${index}.hdrRefusal`, 'refused');
    } else {
      const prefix = family === 'blend' ? `results.${index}` : `transitions.${index}`;
      add(id, 'normal', WORKING_DOMAINS.sdr, `${prefix}.${family === 'blend' ? 'sdr' : 'frames'}`);
      add(id, 'extreme', WORKING_DOMAINS.sdr, `${prefix}.${family === 'blend' ? 'floatSdr' : 'frames'}`);
      (report.cases ?? []).forEach((value, at) => {
        if ((family === 'blend' ? value.mode : value.id) === id && ['animated', 'composed', 'invalid'].includes(value.case))
          add(id, value.case, WORKING_DOMAINS.sdr, `cases.${at}`);
      });
      add(id, 'extreme', WORKING_DOMAINS.hdr, `${prefix}.${family === 'blend' ? 'float' : 'frames.0.hdr'}`,
        family === 'blend' && id === 'normal' ? 'rendered' : 'refused');
    }
  });
  return observations;
}

export function validateDomainReport(report, { build, engineRevision, axis }) {
  assert(report && typeof report === 'object', 'domain report required');
  assert.equal(report.schemaVersion, 1, 'domain report schema');
  assert.equal(report.kind, 'studio-domain-regression', 'domain report kind');
  assert.equal(report.result, 'passed', 'domain report assertions must pass');
  assert.equal(report.browser.name, axis, 'report cannot cover another browser');
  assert.match(report.browser.userAgent, axis === 'firefox' ? /Firefox\// : axis === 'safari' ? /Safari\// : /(Chrome|Chromium)\//, 'observed browser identity required');
  if (axis === 'safari') assert(!/(Chrome|Chromium|Firefox)\//.test(report.browser.userAgent), 'Safari identity cannot be another browser');
  assert.equal(report.source.engineRevision, engineRevision, 'report engine revision');
  assert.equal(report.source.sourceSha256, build.sourceSha256, 'report tested source mismatch');
  assert.deepEqual(report.source.patches, build.patches, 'report tested patches mismatch');
  assert.match(report.source.commit, /^[a-f0-9]{40}$/, 'report tested commit');
  assert.match(report.source.runner.path, /^studio\/tools\/(effects|blend|transition)-matrix\.browser\.mjs$/);
  assert.match(report.source.runner.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.source.bindings.map((entry) => entry.path), REPORT_BINDINGS, 'report harness/oracle/domain bindings required');
  for (const entry of report.source.bindings) assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert(Array.isArray(report.observations) && report.observations.length > 0, 'observed feature/case evidence required');
  const routes = domainObservations(report);
  const routeKey = entry => `${entry.fixtureId}/${entry.workingDomain.id}`;
  const bindings = new Map(routes.map(entry => [routeKey(entry), entry]));
  assert.equal(bindings.size, routes.length, 'duplicate measured operator/case route');
  const seen = new Set();
  for (const entry of report.observations) {
    assert.match(entry.fixtureId, /^(effect|blend|transition)\.[a-zA-Z0-9-]+\/apply\/(normal|extreme|animated|composed|invalid)$/);
    assert(report.source.runner.path.endsWith(`${entry.fixtureId.split('.')[0]}${entry.fixtureId.startsWith('effect.') ? 's' : ''}-matrix.browser.mjs`), 'runner cannot claim another operator family');
    const domain = Object.values(WORKING_DOMAINS).find((value) => value.id === entry.workingDomain?.id);
    assert(domain, 'unknown working domain');
    assert.deepEqual(entry.workingDomain, domain, 'working domain conventions mismatch');
    const key = `${entry.fixtureId}/${domain.id}`;
    assert(!seen.has(key), `duplicate observed case: ${key}`); seen.add(key);
    assert.equal(entry.result, 'passed', 'observed case did not pass');
    assert(['rendered', 'refused'].includes(entry.expected), 'expected outcome required');
    assert.equal(entry.observed, entry.expected, 'observed outcome differs');
    assert(typeof entry.oracle === 'string' && entry.oracle.trim(), 'case oracle required');
    assert(typeof entry.witness === 'string' && entry.witness.trim(), 'measurement witness required');
    const route = bindings.get(key);
    assert(route, `unknown measurement route binding: ${key}`);
    for (const field of ['witness', 'expected', 'observed']) assert.equal(entry[field], route[field], `measurement route binding mismatch: ${key}/${field}`);
    const witness = entry.witness.split('.').reduce((value, key) => value?.[key], report);
    assert(witness && typeof witness === 'object', `missing measurement witness: ${entry.witness}`);
    if (entry.observed === 'refused') assert.equal(witness.errorType, 'HdrRenderUnavailableError', 'typed HDR refusal witness required');
    else assert(!witness.error && !witness.errorType && witness.outcome !== 'refused', 'render evidence cannot be an error or refusal');
  }
  return report.observations;
}

export function observedFixtureIds(report, featureId) {
  const key = entry => JSON.stringify([entry.fixtureId, entry.workingDomain.id, entry.witness]);
  const observed = new Set(report.observations.filter(entry => entry.result === 'passed' &&
    entry.expected === 'rendered' && entry.observed === 'rendered').map(key));
  return domainObservations(report).filter(entry => entry.fixtureId.startsWith(`${featureId}/`) &&
    entry.expected === 'rendered' && observed.has(key(entry)) &&
    entry.workingDomain.id === (entry.fixtureId.endsWith('/extreme') ? WORKING_DOMAINS.hdr.id : WORKING_DOMAINS.sdr.id))
    .map(entry => entry.fixtureId);
}
