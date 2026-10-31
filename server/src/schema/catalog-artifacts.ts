import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// Standalone migration tooling loads this module with native ESM, without application aliases.
// eslint-disable-next-line no-restricted-imports
import { validateFrameleafCatalog } from './catalog-authority.js';
import type { DatabaseSchema } from '@frameleaf/sql-tools';

export type ArtifactManifest = {
  sourceCommit: string;
  sha256: string;
};
export const artifactDigest = (contents: string): string => createHash('sha256').update(contents).digest('hex');

/** Missing or mismatched artifacts are fatal; never fall back to mutable model/helper DDL. */
export const readPinnedArtifact = (name: string): string => {
  const root = new URL('catalog/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(`${name}.manifest.json`, root), 'utf8')) as ArtifactManifest;
  const contents = readFileSync(new URL(name, root), 'utf8');
  if (!/^[a-f\d]{40}$/u.test(manifest.sourceCommit) || artifactDigest(contents) !== manifest.sha256) {
    throw new Error(`Canonical artifact digest/provenance mismatch: ${name}`);
  }
  return contents;
};

export const readCatalogArtifact = (name: 'baseline' | 'desired-schema'): DatabaseSchema =>
  validateFrameleafCatalog(JSON.parse(readPinnedArtifact(`${name}.catalog.json`)) as DatabaseSchema);
