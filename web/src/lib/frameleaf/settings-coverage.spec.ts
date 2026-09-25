import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SETTINGS_AREAS } from './settings-areas';
import { PREFERENCE_LEAF_COVERAGE, SETTINGS_LEAF_COVERAGE, type SettingsLeafCoverage } from './settings-coverage';
import { SECRET_CONFIG_PATHS, SECTION_CONFIG_KEYS, SERVER_MANAGED_CONFIG_PATHS } from './system-config-draft';

/**
 * FL-71 settings coverage gate. Every administrator setting (each leaf of `AdminConfigDto`) and
 * every personal preference (each leaf of `UserPreferencesUpdateDto`) in the generated OpenAPI
 * contract must resolve to a place in the Command Center that edits it: a control on a settings
 * page, a credential dialog, a locked policy row, a server-managed value kept out of the draft or a
 * resource action. A new leaf without a row, a stale row, a row whose evidence left its file, a
 * setting group without a page and a changed bound, enum or secret all fail here instead of
 * quietly losing a source control.
 */

type Schema = {
  $ref?: string;
  allOf?: Schema[];
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  nullable?: boolean;
};

const root = resolve(process.cwd(), '..');
const spec = JSON.parse(readFileSync(resolve(root, 'open-api/immich-openapi-specs.json'), 'utf8')) as {
  components: { schemas: Record<string, Schema> };
};
const schemas = spec.components.schemas;

const resolveSchema = (schema: Schema): Schema => {
  if (schema.$ref) {
    return resolveSchema(schemas[schema.$ref.split('/').at(-1)!]);
  }
  if (schema.allOf?.length === 1) {
    return resolveSchema(schema.allOf[0]);
  }
  return schema;
};

const leavesOf = (name: string) => {
  const leaves = new Map<string, Schema>();
  const walk = (schema: Schema, path: string[]) => {
    const resolved = resolveSchema(schema);
    if (resolved.type === 'object' && resolved.properties) {
      for (const [key, child] of Object.entries(resolved.properties)) {
        walk(child, [...path, key]);
      }
      return;
    }
    leaves.set(path.join('.'), resolved);
  };
  walk(schemas[name], []);
  return leaves;
};

const matches = (pattern: string, path: string) => {
  const a = pattern.split('.');
  const b = path.split('.');
  return a.length === b.length && a.every((part, index) => part === '*' || part === b[index]);
};

const sources = new Map<string, string>();
const source = (file: string) => {
  if (!sources.has(file)) {
    sources.set(file, readFileSync(resolve(process.cwd(), file), 'utf8'));
  }
  return sources.get(file)!;
};

/** A leaf's contract as the server declares it: what a control must respect. */
const contractOf = (schema: Schema) => {
  const item = schema.items ? resolveSchema(schema.items) : undefined;
  return {
    type: schema.type ?? 'unknown',
    ...(schema.format && { format: schema.format }),
    ...(schema.enum && { enum: schema.enum }),
    ...(item?.enum && { itemEnum: item.enum }),
    ...(schema.minimum !== undefined && { minimum: schema.minimum }),
    ...(schema.maximum !== undefined && { maximum: schema.maximum }),
    ...(schema.nullable && { nullable: true }),
  };
};

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));

const checkCoverage = (leaves: Map<string, Schema>, coverage: readonly SettingsLeafCoverage[]) => {
  const paths = Array.from(leaves.keys());
  const rowsFor = (path: string) => coverage.filter((row) => matches(row.pattern, path));
  return {
    unmatched: paths.filter((path) => rowsFor(path).length === 0),
    doubled: paths.filter((path) => rowsFor(path).length > 1),
    stale: coverage.filter((row) => paths.every((path) => !matches(row.pattern, path))).map((row) => row.pattern),
    missingEvidence: coverage.filter((row) => !source(row.file).includes(row.evidence)),
  };
};

describe('settings coverage (FL-71)', () => {
  const adminLeaves = leavesOf('AdminConfigDto');
  const preferenceLeaves = leavesOf('UserPreferencesUpdateDto');

  it('places every administrator setting on a page, exactly once, with its control still there', () => {
    expect(adminLeaves.size).toBeGreaterThan(200);
    expect(checkCoverage(adminLeaves, SETTINGS_LEAF_COVERAGE)).toEqual({
      unmatched: [],
      doubled: [],
      stale: [],
      missingEvidence: [],
    });
  });

  it('places every personal preference, exactly once, with its control still there', () => {
    expect(checkCoverage(preferenceLeaves, PREFERENCE_LEAF_COVERAGE)).toEqual({
      unmatched: [],
      doubled: [],
      stale: [],
      missingEvidence: [],
    });
  });

  it('gives every settings group a page, and every page a place in an area', () => {
    const groups = new Set([...adminLeaves.keys()].map((path) => path.split('.', 1)[0]));
    const sectionOf = (group: string) =>
      Object.entries(SECTION_CONFIG_KEYS).find(([, keys]) => (keys as readonly string[]).includes(group))?.[0];
    expect([...groups].filter((group) => !sectionOf(group))).toEqual([]);

    const placed = new Set(SETTINGS_AREAS.flatMap((area) => [...area.sections, ...(area.personal ?? [])]));
    expect(Object.keys(SECTION_CONFIG_KEYS).filter((section) => !placed.has(section))).toEqual([]);
  });

  it('keeps credentials write-only and server-managed values out of the forms', () => {
    const credentialRows = SETTINGS_LEAF_COVERAGE.filter((row) => row.kind === 'credential');
    expect(sorted(credentialRows.map((row) => row.pattern))).toEqual(sorted(SECRET_CONFIG_PATHS));
    // a credential is only ever a CredentialRow, never a bound field
    const boundCredentials = credentialRows.filter((row) =>
      source(row.file).includes(`bind:value={configToEdit.${row.pattern}}`),
    );
    expect(boundCredentials).toEqual([]);

    // the draft keeps server-managed values and credential flags out; the timestamps are the
    // server-managed settings
    const managed = SETTINGS_LEAF_COVERAGE.filter((row) => row.kind === 'server-managed').map((row) => row.pattern);
    expect(sorted(managed)).toEqual(
      sorted([...SERVER_MANAGED_CONFIG_PATHS].filter((path) => !path.endsWith('Configured'))),
    );

    const states = SETTINGS_LEAF_COVERAGE.filter((row) => row.kind === 'credential-state');
    expect(states.filter((row) => !row.pattern.endsWith('Configured'))).toEqual([]);
  });

  it('matches the reviewed bounds, choices and types of every setting', async () => {
    // Changing a bound, an enum or a type on the server changes what a control must allow: this
    // snapshot fails until the settings pages are checked against the new contract and it is updated.
    const contract = Object.fromEntries(
      [...adminLeaves, ...[...preferenceLeaves].map(([path, schema]) => [`preferences.${path}`, schema] as const)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, schema]) => [path, contractOf(schema)]),
    );
    await expect(JSON.stringify(contract, null, 2) + '\n').toMatchFileSnapshot('./settings-coverage.contract.snap');
  });
});
