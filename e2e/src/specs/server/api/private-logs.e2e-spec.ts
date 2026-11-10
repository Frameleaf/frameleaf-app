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
    const archive = await request(app).get('/admin/logs/download').set('Authorization', adminAuth).expect(200);
    expect(archive.headers['content-type']).toContain('application/zip');
  });
});
