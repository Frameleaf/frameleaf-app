import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  encodeImportSourceAuthorityRequest,
  parseImportSourceAuthorityResponse,
  replyImportSourceAuthority,
  type ImportSourceAuthority,
} from '../src/import-source-authority.js';

const sources = [
  'immich',
  'photoprism',
  'librephotos',
  'photoview',
  'piwigo',
  'lychee',
  'pigallery2',
  'ente',
  'nextcloud',
  'synology',
] as const;
const fixture = (kind: (typeof sources)[number] = 'photoprism') => {
  let checked = 0;
  const authority: ImportSourceAuthority = {
    installation: 'a'.repeat(12),
    binding: {
      operationId: randomUUID(),
      manifestSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      source: { kind, version: 'synthetic', identity: 'fixture', revision: 'frozen', schemaSha256: 'c'.repeat(64) },
    },
    destinationId: randomUUID(),
    verify: async () => {
      checked++;
    },
  };
  const nonce = randomUUID();
  const line = encodeImportSourceAuthorityRequest('run', authority, nonce);
  return { authority, nonce, line, checked: () => checked };
};

for (const source of sources) {
  test(`${source} uses the same reviewed binding and live source-authority check`, async () => {
    const { authority, nonce, line, checked } = fixture(source);
    const response = await replyImportSourceAuthority(line.trimEnd(), 'run', authority);
    assert.equal(checked(), 1);
    assert.equal(parseImportSourceAuthorityResponse(response!.trimEnd(), nonce), undefined);
  });
}

test('changed operation, manifest, file plan, source, destination or action never reaches source checks', async () => {
  const { authority, line, checked } = fixture();
  for (const change of [
    (input: any) => {
      input.installation = 'b'.repeat(12);
    },
    (input: any) => {
      input.binding.operationId = randomUUID();
    },
    (input: any) => {
      input.binding.manifestSha256 = 'd'.repeat(64);
    },
    (input: any) => {
      input.binding.planSha256 = 'd'.repeat(64);
    },
    (input: any) => {
      input.binding.source.revision = 'changed';
    },
    (input: any) => {
      input.destinationId = randomUUID();
    },
    (input: any) => {
      input.action = 'verify';
    },
    (input: any) => {
      input.password = 'never-accepted';
    },
  ]) {
    const input = JSON.parse(line);
    change(input);
    await assert.rejects(replyImportSourceAuthority(JSON.stringify(input), 'run', authority), {
      message: 'import_source_authority_invalid',
    });
  }
  assert.equal(checked(), 0);
});

test('missing or failed live authority cannot approve a challenge or expose its private error', async () => {
  const { authority, line } = fixture();
  await assert.rejects(replyImportSourceAuthority(line.trimEnd(), 'run'), {
    message: 'import_source_authority_required',
  });
  authority.verify = async () => {
    throw new Error('synthetic-private-evidence');
  };
  await assert.rejects(replyImportSourceAuthority(line.trimEnd(), 'run', authority), {
    message: 'import_source_authority_refused',
  });
});

test('ordinary command output requires no source approval and is never treated as a challenge', async () => {
  for (const line of ['Starting offline import', '{"run":null,"execution":null}', '{not-json'])
    assert.equal(await replyImportSourceAuthority(line, 'status'), undefined);
});

test('responses must approve this exact one-use challenge without extra fields', async () => {
  const { authority, line, nonce } = fixture();
  const accepted = await replyImportSourceAuthority(line.trimEnd(), 'run', authority);
  for (const change of [
    (input: any) => {
      input.nonce = randomUUID();
    },
    (input: any) => {
      input.allowed = false;
    },
    (input: any) => {
      input.password = 'never-accepted';
    },
  ]) {
    const input = JSON.parse(accepted!);
    change(input);
    assert.throws(() => parseImportSourceAuthorityResponse(JSON.stringify(input), nonce), {
      message: 'import_source_authority_unavailable',
    });
  }
});
