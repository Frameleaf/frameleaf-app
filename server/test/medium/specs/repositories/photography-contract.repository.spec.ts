import { NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  PhotographyContractRepository,
  contractEventSha256,
} from 'src/repositories/photography-contract.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const request = { ip: '203.0.113.9', userAgent: 'Test' };
const signer = (documentSha256: string) => ({
  name: 'Morgan Ellis',
  signatureType: 'typed' as const,
  signaturePng: null,
  documentSha256,
  consentSha256: sha256('consent'),
});

it('signs once, then refuses every change, and keeps an unbroken event chain', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const repository = new PhotographyContractRepository(db);
  const template = await repository.createTemplate(user.id, { name: 'Agreement', body: 'Hi {client_name}' });
  await expect(repository.template(other.id, template.id)).rejects.toBeInstanceOf(NotFoundException);

  const body = 'Hi Morgan';
  const created = await repository.create({
    ownerId: user.id,
    templateId: template.id,
    name: 'Agreement',
    clientName: 'Morgan Ellis',
    clientEmail: 'morgan@example.test',
    body,
    documentSha256: sha256(body),
  });
  await expect(repository.get(other.id, created.id)).rejects.toBeInstanceOf(NotFoundException);
  expect(
    await repository.send(other.id, created.id, sha256('t'), new Date(Date.now() + 60_000)).catch(() => null),
  ).toBe(null);

  const tokenHash = sha256('token');
  await repository.send(user.id, created.id, tokenHash, new Date(Date.now() + 60_000));
  expect((await repository.byToken(tokenHash))?.id).toBe(created.id);
  expect(await repository.byToken(sha256('other'))).toBeUndefined();
  await repository.viewed(created.id, request, 'morgan@example.test');

  expect(await repository.sign(created.id, tokenHash, signer(sha256('changed')), request)).toBeNull();
  const signed = await repository.sign(created.id, tokenHash, signer(sha256(body)), request);
  expect(signed?.status).toBe('signed');

  expect(await repository.sign(created.id, tokenHash, signer(sha256(body)), request)).toBeNull();
  expect(await repository.void(user.id, created.id)).toBeNull();
  expect(await repository.send(user.id, created.id, sha256('again'), new Date(Date.now() + 60_000))).toBeNull();
  await repository.finalize(created.id, '/contract.pdf', sha256('pdf'));
  expect(await repository.finalize(created.id, '/other.pdf', sha256('other'))).toBeNull();
  const after = await repository.get(user.id, created.id);
  expect(after).toMatchObject({ status: 'signed', body, documentSha256: sha256(body), pdfPath: '/contract.pdf' });

  const events = await repository.events(created.id);
  expect(events.map(({ type }) => type)).toEqual([
    'created',
    'sent',
    'email_verified',
    'viewed',
    'consented',
    'signed',
    'finalized',
  ]);
  let previous: string | null = null;
  for (const { sha256: hash, ...event } of events) {
    expect(event.prevEventSha256).toBe(previous);
    expect(contractEventSha256(event)).toBe(hash);
    previous = hash;
  }
});

it('stops an expired or voided link from opening the contract', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new PhotographyContractRepository(db);
  const contract = await repository.create({
    ownerId: user.id,
    templateId: null,
    name: 'Agreement',
    clientName: 'Morgan',
    clientEmail: 'morgan@example.test',
    body: 'Text',
    documentSha256: sha256('Text'),
  });
  await repository.send(user.id, contract.id, sha256('expired'), new Date(Date.now() - 1000));
  expect(await repository.byToken(sha256('expired'))).toBeUndefined();
  await repository.send(user.id, contract.id, sha256('live'), new Date(Date.now() + 60_000));
  expect(await repository.byToken(sha256('expired'))).toBeUndefined();
  await repository.void(user.id, contract.id);
  expect(await repository.byToken(sha256('live'))).toBeUndefined();
});
