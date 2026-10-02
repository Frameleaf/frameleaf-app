import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_ENV_ALIASES, applyCliEnvAliases, preferExisting } from './env-aliases.js';

describe('CLI env aliases (FL-294)', () => {
  it('gives every option variable a FRAMELEAF_ name with the same suffix', () => {
    for (const [legacy, current] of CLI_ENV_ALIASES) {
      expect(legacy).toMatch(/^IMMICH_/);
      expect(current).toBe(legacy.replace(/^IMMICH_/, 'FRAMELEAF_'));
    }
    expect(CLI_ENV_ALIASES.map(([legacy]) => legacy)).toEqual(
      expect.arrayContaining(['IMMICH_INSTANCE_URL', 'IMMICH_API_KEY', 'IMMICH_FROM_KEY', 'IMMICH_TO_KEY']),
    );
  });

  it('copies an old name to its new name and warns once on stderr', () => {
    const env: NodeJS.ProcessEnv = { IMMICH_INSTANCE_URL: 'https://a.example/api', IMMICH_API_KEY: 'k' };
    const warn = vi.fn();

    expect(applyCliEnvAliases(env, warn)).toEqual([]);

    expect(env.FRAMELEAF_INSTANCE_URL).toBe('https://a.example/api');
    expect(env.FRAMELEAF_API_KEY).toBe('k');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IMMICH_INSTANCE_URL → FRAMELEAF_INSTANCE_URL'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IMMICH_API_KEY → FRAMELEAF_API_KEY'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'The old names still work in this major version and stop working in the next major release.',
      ),
    );
  });

  it('does not warn when only new names are used', () => {
    const warn = vi.fn();
    expect(applyCliEnvAliases({ FRAMELEAF_API_KEY: 'k' }, warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses two different values, without printing either', () => {
    const env: NodeJS.ProcessEnv = { IMMICH_API_KEY: 'secret-a', FRAMELEAF_API_KEY: 'secret-b' };
    const warn = vi.fn();

    expect(applyCliEnvAliases(env, warn)).toHaveLength(1);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('FRAMELEAF_API_KEY and its deprecated alias IMMICH_API_KEY'),
    );
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/secret-/);
  });
});

describe('preferExisting', () => {
  let directory: string;

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('uses the new location when it exists or neither does', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'frameleaf-cli-'));
    const current = path.join(directory, 'frameleaf');
    const legacy = path.join(directory, 'immich');
    expect(preferExisting(current, legacy)).toBe(current);

    mkdirSync(current);
    mkdirSync(legacy);
    expect(preferExisting(current, legacy)).toBe(current);
  });

  it('keeps using the old location while only it exists, so a saved login or ledger is not lost', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'frameleaf-cli-'));
    const legacy = path.join(directory, 'immich-migrate.sqlite');
    writeFileSync(legacy, '');
    expect(preferExisting(path.join(directory, 'frameleaf-migrate.sqlite'), legacy)).toBe(legacy);
  });
});
