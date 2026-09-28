#!/usr/bin/env node
/**
 * FL-86 (STU-103): publish the reviewed Studio resource rights decisions to the server.
 *
 * `studio/dependency-attribution.json` is the reviewed bill of materials: every model, voice,
 * font, bundled weight, runtime download, asset service and tool the pinned engine can reach,
 * each with three decisions (redistribution, local runtime, hosted use). Those decisions stay as
 * the engine packager reviewed them. `studio/rights-approval.json` records the owner's approval
 * (FL-146, September 25, 2026, afternoon: all 210 bundled resources approved), bound to a digest
 * of each approved row. An approved row may name uses the owner withheld (`excludedUses`, with the
 * reason, e.g. MusicGen-small's CC-BY-NC-4.0 licence keeps it off hosted use, FL-146 comment
 * 34944); those uses stay blocked and the refusal carries the reason. The server mirror admits a use when the reviewed decision allows it or the
 * owner approved that exact row; a row that changed after approval, or a resource that is new or
 * unknown, stays blocked. The resolver that admits Studio graph resources refuses a blocked one by
 * name instead of loading it.
 *
 *   node scripts/frameleaf-studio-rights.mjs           verify the mirror is current (CI)
 *   node scripts/frameleaf-studio-rights.mjs --write   regenerate it
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ATTRIBUTION_PATH = 'studio/dependency-attribution.json';
export const SERVER_MIRROR_PATH = 'server/src/utils/studio-rights.generated.ts';
export const APPROVAL_PATH = 'studio/rights-approval.json';
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

const canonical = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** The digest an approval is bound to: what the resource is, not how it was reviewed. */
export const approvalRowDigest = (resource) =>
  createHash('sha256')
    .update(
      canonical({
        id: resource.id,
        kind: resource.kind,
        locator: resource.locator ?? null,
        revision: resource.revision ?? null,
        licenseDeclared: resource.licenseDeclared ?? null,
        files: resource.files ?? null,
      }),
    )
    .digest('hex');

const failApproval = (message) => {
  throw new Error(`${APPROVAL_PATH}: ${message}`);
};

/**
 * The owner's approval record: who approved, when, where it is recorded, and the rows it covers.
 * Returns null when there is no approval file. An approved id that is not in the manifest fails.
 */
export function ownerApproval(approval, manifest) {
  if (approval === null) {
    return null;
  }
  if (approval?.schemaVersion !== 1) {
    failApproval('schemaVersion must be 1');
  }
  for (const key of ['approvedBy', 'approvedOn', 'source']) {
    if (typeof approval[key] !== 'string' || approval[key].length === 0) {
      failApproval(`${key} is required`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(approval.approvedOn)) {
    failApproval('approvedOn must be a date (YYYY-MM-DD)');
  }
  const uses = approval.uses;
  if (!Array.isArray(uses) || uses.length === 0 || uses.some((use) => !RIGHTS_USES.includes(use))) {
    failApproval(`uses must name some of ${RIGHTS_USES.join(', ')}`);
  }
  const byId = new Map((manifest.resources ?? []).map((resource) => [resource.id, resource]));
  const approved = new Map();
  const excluded = new Map();
  for (const entry of approval.resources ?? []) {
    const resource = byId.get(entry?.id);
    if (!resource) {
      failApproval(`${entry?.id} is not a reviewed resource`);
    }
    if (approved.has(entry.id)) {
      failApproval(`duplicate approval ${entry.id}`);
    }
    // A row that changed after it was approved is not what the owner approved: it stays blocked.
    approved.set(entry.id, entry.sha256 === approvalRowDigest(resource));
    if (entry.excludedUses !== undefined) {
      const exclusions = entry.excludedUses;
      if (!exclusions || typeof exclusions !== 'object' || Array.isArray(exclusions)) {
        failApproval(`${entry.id} excludedUses must map a use to its reason`);
      }
      for (const [use, reason] of Object.entries(exclusions)) {
        if (!RIGHTS_USES.includes(use)) {
          failApproval(`${entry.id} excludes unknown use ${use}`);
        }
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          failApproval(`${entry.id} must give the reason ${use} is excluded`);
        }
      }
      excluded.set(entry.id, exclusions);
    }
  }
  return {
    approvedBy: approval.approvedBy,
    approvedOn: approval.approvedOn,
    source: approval.source,
    uses,
    approved,
    excluded,
  };
}

const quote = (value) => (value === null ? 'null' : `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`);

export function buildServerMirror(manifestText, approvalText = null) {
  const manifest = JSON.parse(manifestText);
  const { distributionApproval, rows: reviewed } = rightsRows(manifest);
  const approval = ownerApproval(approvalText === null ? null : JSON.parse(approvalText), manifest);
  const rows = reviewed.map((row) => {
    const approved = approval?.approved.get(row.id) === true;
    const excluded = approval?.excluded.get(row.id) ?? {};
    const decide = (use) =>
      row[use] === ALLOWED || (approved && approval.uses.includes(use) && !Object.hasOwn(excluded, use))
        ? ALLOWED
        : 'blocked';
    const restrictions = RIGHTS_USES.filter((use) => Object.hasOwn(excluded, use)).map((use) => [use, excluded[use]]);
    return {
      ...row,
      redistribution: decide('redistribution'),
      localRuntime: decide('localRuntime'),
      hostedUse: decide('hostedUse'),
      approvedOn: approved ? approval.approvedOn : null,
      restrictions,
    };
  });
  const sha256 = createHash('sha256').update(manifestText).digest('hex');
  const approvalSha256 = approvalText === null ? null : createHash('sha256').update(approvalText).digest('hex');
  const lines = [
    '/**',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ` * Source: ${ATTRIBUTION_PATH}`,
    ` * Generator: ${GENERATOR}`,
    ' *',
    ' * The reviewed rights decisions for every resource the pinned Studio engine can reach (FL-86,',
    " * `STU-103`). A use is admitted only when its decision is 'allowed': reviewed so, or approved by",
    ` * the owner in ${APPROVAL_PATH} for that exact row. A new, changed or unknown resource stays`,
    ' * blocked. Enforcement lives in `studio-rights.ts`.',
    ' */',
    '',
    "export type StudioRightsDecision = 'allowed' | 'blocked';",
    '',
    "export type StudioRightsUseName = 'redistribution' | 'localRuntime' | 'hostedUse';",
    '',
    'export type StudioResourceRights = {',
    '  kind: string;',
    '  license: string | null;',
    '  redistribution: StudioRightsDecision;',
    '  localRuntime: StudioRightsDecision;',
    '  hostedUse: StudioRightsDecision;',
    '  /** The date the owner approved this exact row, or null when it was not approved. */',
    '  approvedOn: string | null;',
    '  /** Why the owner withheld a use of an approved row. A refusal repeats the reason. */',
    '  restrictions: Readonly<Partial<Record<StudioRightsUseName, string>>>;',
    '};',
    '',
    `export const STUDIO_RIGHTS_SOURCE_SHA256 = '${sha256}';`,
    '',
    '/** The owner approval the allowed rows come from, or null when there is none. */',
    approval === null
      ? 'export const STUDIO_RIGHTS_APPROVAL = null;'
      : [
          'export const STUDIO_RIGHTS_APPROVAL = {',
          `  approvedBy: ${quote(approval.approvedBy)},`,
          `  approvedOn: ${quote(approval.approvedOn)},`,
          // Wrapped the way prettier wraps a long property, so the generated file stays formatted.
          `  source: ${quote(approval.source)},`.length > 120
            ? `  source:\n    ${quote(approval.source)},`
            : `  source: ${quote(approval.source)},`,
          `  sha256: ${quote(approvalSha256)},`,
          '} as const;',
        ].join('\n'),
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
      `    approvedOn: ${quote(row.approvedOn)},`,
      ...(row.restrictions.length === 0
        ? ['    restrictions: {},']
        : [
            '    restrictions: {',
            ...row.restrictions.flatMap(([use, reason]) =>
              `      ${use}: ${quote(reason)},`.length > 120
                ? [`      ${use}:`, `        ${quote(reason)},`]
                : [`      ${use}: ${quote(reason)},`],
            ),
            '    },',
          ]),
      '  },',
    ]),
    '};',
    '',
  ];
  return lines.join('\n');
}

export async function generate(root) {
  const manifestText = await readFile(path.join(root, ATTRIBUTION_PATH), 'utf8');
  const approvalText = await readFile(path.join(root, APPROVAL_PATH), 'utf8').catch((error) =>
    error?.code === 'ENOENT' ? null : Promise.reject(error),
  );
  return { [SERVER_MIRROR_PATH]: buildServerMirror(manifestText, approvalText) };
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
