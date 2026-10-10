// FL-97 inventory of literal 8-bit formats, pooled textures and direct literal
// Canvas2D contexts. Detected sites need an exact declaration and a reason.
// shortcut: indirect allocations are not detected; qualify their graph callers
// before claiming complete HDR route coverage.
//   node studio/tools/allocation-audit.mjs          check (CI, after prepare)
//   node studio/tools/allocation-audit.mjs --list   print the current sites
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(studio, 'engine/src');
const registryPath = path.join(studio, 'graph-allocation-audit.json');
const PATTERN = new RegExp([
  "'(?:rgba8unorm|bgra8unorm|rgba8unorm-srgb|bgra8unorm-srgb|r8unorm|rg8unorm)'",
  'getPreferredCanvasFormat\\(',
  'getContext\\s*\\(\\s*[\'\"]2d[\'\"]',
  '(?:canvasPool|texturePool!?|gpuTexturePool|gpuScratchTexturePool\\?)\\.acquire\\(',
  'acquireScratchTexture\\(',
].join('|'));
export const CLASSES = {
  'legacy-sdr-route': 'Freecut 8-bit route kept for SDR callers; float callers pass rgba16float.',
  'display-output': 'Explicit conversion to a display canvas.',
  coverage: 'Mask or alpha coverage in [0, 1]; carries no colour.',
  'sdr-graphics': 'SDR graphics (text, Canvas2D-only items) entering at reference white.',
  'sdr-source-ingest': 'Browser-decoded media upload; HDR source decode is not yet in the browser graph.',
  'canvas2d-legacy': 'Canvas2D intermediate on the legacy route; the float route does not reach it.',
  'canvas2d-context': 'Direct Canvas2D context; declaration does not qualify its HDR route reachability.',
  'preview-cache': 'SDR preview scrub cache.',
  'format-dispatch': 'A format check or type, not an allocation.',
  float: 'Float allocation (rgba16float) or pooled texture of the caller\'s float format.',
  debug: 'Debug tooling outside the render graph.',
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full;
  }
}

export async function scan() {
  const sites = [];
  for await (const file of walk(source)) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (PATTERN.test(line)) sites.push({ file: path.relative(source, file), line: index + 1, code: line.trim() });
    });
  }
  return sites;
}

const key = ({ file, code }) => `${file}\u0000${code}`;

export async function audit() {
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const sites = await scan();
  const problems = [];
  const counts = new Map();
  for (const site of sites) counts.set(key(site), (counts.get(key(site)) ?? 0) + 1);
  const declared = new Map();
  for (const entry of registry.sites) {
    if (!CLASSES[entry.class]) problems.push(`Unknown class ${entry.class} for ${entry.file}: ${entry.code}`);
    if (!entry.reason?.trim()) problems.push(`Missing reason for ${entry.file}: ${entry.code}`);
    declared.set(key(entry), entry.count ?? 1);
  }
  for (const [k, count] of counts) {
    const [file, code] = k.split('\u0000');
    if (!declared.has(k)) problems.push(`Undeclared allocation site ${file}: ${code}`);
    else if (declared.get(k) !== count) problems.push(`${file}: ${code} occurs ${count}x, declared ${declared.get(k)}x`);
  }
  for (const [k] of declared) {
    if (!counts.has(k)) problems.push(`Declared site no longer present: ${k.replace('\u0000', ': ')}`);
  }
  return { sites, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--list')) {
    for (const site of await scan()) console.log(`${site.file}:${site.line}\t${site.code}`);
  } else {
    const { sites, problems } = await audit();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(JSON.stringify({ check: 'graph allocation audit', sites: sites.length }));
  }
}
