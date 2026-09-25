#!/usr/bin/env node
/**
 * FL-86 (STU-103): publish the reviewed Studio resource rights decisions to the server.
 *
 * `studio/dependency-attribution.json` is the reviewed bill of materials: every model, voice,
 * font, bundled weight, runtime download, asset service and tool the pinned engine can reach,
 * each with three decisions (redistribution, local runtime, hosted use). The owner's decision
 * (FL-146, September 25, 2026) is that each stays "blocked" until it is approved one resource
 * at a time. This script copies those decisions, unchanged, into a server mirror so the resolver
 * that admits Studio graph resources can refuse a blocked one by name instead of loading it.
 *
 *   node scripts/frameleaf-studio-rights.mjs           verify the mirror is current (CI)
 *   node scripts/frameleaf-studio-rights.mjs --write   regenerate it
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ATTRIBUTION_PATH = 'studio/dependency-attribution.json';
export const SERVER_MIRROR_PATH = 'server/src/utils/studio-rights.generated.ts';
const GENERATOR = 'scripts/frameleaf-studio-rights.mjs';

/** The only value that admits a use. Anything else (today: "blocked") refuses it. */
export const ALLOWED = 'allowed';
export const RIGHTS_USES = ['redistribution', 'localRuntime', 'hostedUse'];
const DECISION_VALUES = new Set(['allowed', 'blocked']);

const fail = (message) => {
  throw new Error(`${ATTRIBUTION_PATH}: ${message}`);
};

/** Validates the manifest's rights rows and returns them sorted by id. */
export function rightsRows(manifest) {
  if (manifest?.schemaVersion !== 1) {
    fail('schemaVersion must be 1');
  }
  const policy = manifest.rightsPolicy;
  if (!policy || typeof policy.distributionApproval !== 'boolean') {
    fail('rightsPolicy.distributionApproval must be a boolean');
  }
  if (policy.unknownResource !== 'blocked') {
    fail('rightsPolicy.unknownResource must stay "blocked"');
  }
  if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) {
    fail('resources must be a non-empty array');
  }
  const seen = new Set();
  const rows = manifest.resources.map((resource) => {
    const { id, kind, decisions, licenseDeclared } = resource ?? {};
    if (typeof id !== 'string' || !/^[a-z-]+:.+$/.test(id)) {
      fail(`resource id ${JSON.stringify(id)} must be "<kind>:<name>"`);
    }
    if (seen.has(id)) {
      fail(`duplicate resource ${id}`);
    }
    seen.add(id);
    if (typeof kind !== 'string' || kind.length === 0) {
      fail(`${id} has no kind`);
    }
    for (const use of RIGHTS_USES) {
      if (!DECISION_VALUES.has(decisions?.[use])) {
        // An unreviewed row blocks itself rather than disappearing from the mirror.
        fail(`${id} has no reviewed ${use} decision`);
      }
    }
    if (Object.keys(decisions).some((key) => !RIGHTS_USES.includes(key))) {
      fail(`${id} has an unknown decision`);
    }
    return {
      id,
      kind,
      license: typeof licenseDeclared === 'string' ? licenseDeclared : null,
      redistribution: decisions.redistribution,
      localRuntime: decisions.localRuntime,
      hostedUse: decisions.hostedUse,
    };
  });
  return {
    distributionApproval: policy.distributionApproval,
    rows: rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

const quote = (value) => (value === null ? 'null' : `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`);

export function buildServerMirror(manifestText) {
  const { distributionApproval, rows } = rightsRows(JSON.parse(manifestText));
  const sha256 = createHash('sha256').update(manifestText).digest('hex');
  const lines = [
    '/**',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ` * Source: ${ATTRIBUTION_PATH}`,
    ` * Generator: ${GENERATOR}`,
    ' *',
    ' * The reviewed rights decisions for every resource the pinned Studio engine can reach (FL-86,',
    " * `STU-103`). A use is admitted only when its decision is 'allowed'; the owner's default",
    ' * (FL-146, September 25, 2026) keeps every row blocked until it is approved individually.',
    ' * Enforcement lives in `studio-rights.ts`.',
    ' */',
    '',
    "export type StudioRightsDecision = 'allowed' | 'blocked';",
    '',
    'export type StudioResourceRights = {',
    '  kind: string;',
    '  license: string | null;',
    '  redistribution: StudioRightsDecision;',
    '  localRuntime: StudioRightsDecision;',
    '  hostedUse: StudioRightsDecision;',
    '};',
    '',
    `export const STUDIO_RIGHTS_SOURCE_SHA256 = '${sha256}';`,
    '',
    '/** Whether the engine as a whole may be redistributed. False blocks every redistribution. */',
    `export const STUDIO_DISTRIBUTION_APPROVAL = ${distributionApproval};`,
    '',
    'export const studioResourceRights: Readonly<Record<string, StudioResourceRights>> = {',
    ...rows.flatMap((row) => [
      `  ${quote(row.id)}: {`,
      `    kind: ${quote(row.kind)},`,
      `    license: ${quote(row.license)},`,
      `    redistribution: ${quote(row.redistribution)},`,
      `    localRuntime: ${quote(row.localRuntime)},`,
      `    hostedUse: ${quote(row.hostedUse)},`,
      '  },',
    ]),
    '};',
    '',
  ];
  return lines.join('\n');
}

export async function generate(root) {
  const manifestText = await readFile(path.join(root, ATTRIBUTION_PATH), 'utf8');
  return { [SERVER_MIRROR_PATH]: buildServerMirror(manifestText) };
}

export async function main(argv, root) {
  const write = argv.includes('--write');
  const files = await generate(root);
  const stale = [];
  for (const [file, expected] of Object.entries(files)) {
    const target = path.join(root, file);
    if (write) {
      await writeFile(target, expected);
      continue;
    }
    const actual = await readFile(target, 'utf8').catch(() => null);
    if (actual !== expected) {
      stale.push(file);
    }
  }
  if (stale.length > 0) {
    process.stderr.write(`Studio rights mirror is stale:\n  ${stale.join('\n  ')}\nRun: node ${GENERATOR} --write\n`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), process.cwd());
}
