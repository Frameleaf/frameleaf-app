import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('Local server logs', () => {
  beforeAll(async () => {
    await utils.resetDatabase();
  });

  it('shows redacted API activity only to a signed-in administrator', async () => {
    const admin = await utils.adminSetup();
    const member = await utils.userSetup(admin.accessToken, createUserDto.create('local-server-logs'));
    const adminAuth = `Bearer ${admin.accessToken}`;
    const memberAuth = `Bearer ${member.accessToken}`;
    await request(app).get('/admin/logs').expect(401);
    for (const path of ['/admin/logs', '/admin/logs/stream', '/admin/logs/download']) {
      await request(app).get(path).set('Authorization', memberAuth).expect(403);
    }
    await request(app).get('/server/no-log-fixture?token=private-request-value').expect(404);
    await expect
      .poll(
        async () => {
          const { body } = await request(app)
            .get('/admin/logs')
            .query({ worker: 'api', q: 'no-log-fixture' })
            .set('Authorization', adminAuth)
            .expect(200);
          return body.entries.find((entry: { message: string }) => entry.message.includes('no-log-fixture'));
        },
        { timeout: 10_000 },
      )
      .toMatchObject({
        message: expect.stringMatching(/no-log-fixture.*\[redacted\].*404/),
        worker: 'api',
      });
    const archive = await fetch(`${app}/admin/logs/download`, { headers: { Authorization: adminAuth } });
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toContain('application/zip');
    const tempDir = await mkdtemp(join(tmpdir(), 'frameleaf-log-archive-'));
    try {
      const zip = join(tempDir, 'logs.zip');
      await writeFile(zip, Buffer.from(await archive.arrayBuffer()));
      await utils.unzip(zip, tempDir);
      const logs = await readFile(join(tempDir, 'frameleaf-server-logs.jsonl'), 'utf8');
      expect(logs).toMatch(/no-log-fixture.*\[redacted\].*404/);
      expect(logs).not.toContain('private-request-value');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
