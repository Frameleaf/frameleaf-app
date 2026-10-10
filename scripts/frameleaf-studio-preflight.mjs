#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeGpu } from '../studio/tools/gpu-probe.mjs';
import { probeSource } from '../studio/tools/encode-probe.mjs';
import { validatePlan, verdict } from '../studio/tools/preflight-validators.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const attribution = JSON.parse(readFileSync(path.join(root, 'studio/dependency-attribution.json'), 'utf8'));

export function run(binary, args, { rejectStderr = false } = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(binary)} failed (exit ${result.status ?? 'unavailable'})`);
  if (rejectStderr && result.stderr.trim()) throw new Error(`${path.basename(binary)} reported error diagnostics`);
  return result.stdout;
}

export function preflight(plan, execute = run) {
  validatePlan(plan);
  const checks = [];
  for (const name of ['ffmpeg', 'ffprobe']) {
    try {
      const actual = execute(plan.tools[name].path, ['-version']).split(/\r?\n/, 1)[0];
      checks.push({ name: `${name} exact version`, ok: actual === plan.tools[name].version, detail: actual });
    } catch (error) {
      checks.push({ name: `${name} exact version`, ok: false, detail: error.message });
    }
  }
  if (checks.every((check) => check.ok)) {
    for (const [name, probe] of [
      ['gpu accelerator inventory', () => probeGpu(plan.tools.ffmpeg.path, plan.gpu.accelerator, execute)],
      ['source profile and decode', () => probeSource(plan.tools.ffprobe.path, plan.tools.ffmpeg.path, plan.source, execute)],
    ]) {
      try { checks.push(probe()); }
      catch { checks.push({ name, ok: false, detail: 'probe failed' }); }
    }
  }
  return verdict(checks, attribution);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/frameleaf-studio-preflight.mjs /absolute/path/to/local-plan.json');
    const result = preflight(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.goNoGo ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
