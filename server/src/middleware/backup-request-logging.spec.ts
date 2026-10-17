import { APP_INTERCEPTOR } from '@nestjs/core';
import request from 'supertest';
import { BuddyBackupAdminController } from 'src/controllers/buddy-backup.controller.js';
import { CloudBackupAdminController } from 'src/controllers/cloud-backup-admin.controller.js';
import { ConfigAdminController } from 'src/controllers/config-admin.controller.js';
import { ConfigCredential } from 'src/enum.js';
import { ErrorInterceptor } from 'src/middleware/error.interceptor.js';
import { LoggingInterceptor } from 'src/middleware/logging.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { BuddyBackupService } from 'src/services/buddy-backup.service.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe('backup request diagnostics', () => {
  const passphrase = 'synthetic-passphrase-sentinel';
  const kit = {
    version: 1 as const,
    vaultId: '00000000-0000-4000-8000-000000000001',
    current: 1,
    keys: { 1: Buffer.alloc(32, 0x51).toString('base64url') },
  };
  const log = { setContext: vi.fn(), debug: vi.fn(), verbose: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const cloud = { storeEscrow: vi.fn(), startVerify: vi.fn() };
  const buddy = { keyring: vi.fn(), importKit: vi.fn(), verifyKit: vi.fn() };
  const restore = { administrator: vi.fn() };
  const config = { setCredential: vi.fn() };
  const output = () =>
    JSON.stringify([log.debug.mock.calls, log.verbose.mock.calls, log.error.mock.calls, log.warn.mock.calls]);
  let ctx: ControllerContext;

  beforeAll(async () => {
    ctx = await controllerSetup(
      [CloudBackupAdminController, BuddyBackupAdminController, ConfigAdminController],
      [
        { provide: CloudBackupService, useValue: cloud },
        { provide: BuddyBackupService, useValue: buddy },
        { provide: BuddyBackupRestoreService, useValue: restore },
        { provide: SystemConfigService, useValue: config },
        { provide: LoggingRepository, useValue: log },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ErrorInterceptor },
      ],
    );
    return () => ctx.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    ctx.reset();
    cloud.storeEscrow.mockResolvedValue({ configured: true });
    cloud.startVerify.mockResolvedValue({ configured: true });
    buddy.keyring.mockResolvedValue(kit);
    buddy.importKit.mockResolvedValue({ configured: true });
    buddy.verifyKit.mockResolvedValue({ configured: true });
    config.setCredential.mockResolvedValue({ name: ConfigCredential.SmtpPassword, configured: true });
  });

  it('forwards Cloud escrow input without recording the body, including route casing and trailing slash', async () => {
    const { status } = await request(ctx.getHttpServer()).put('/ADMIN/CLOUD/BACKUP/ESCROW/').send({ passphrase });
    expect(status).toBe(200);
    expect(cloud.storeEscrow).toHaveBeenCalledWith(undefined, { passphrase });
    expect(log.verbose).not.toHaveBeenCalled();
    expect(output()).not.toContain(passphrase);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('PUT /ADMIN/CLOUD/BACKUP/ESCROW/ 200'));
  });

  it('wraps and imports a real local Buddy recovery package without logging its contents', async () => {
    const wrapped = await request(ctx.getHttpServer()).post('/admin/buddy-backup/key/escrow').send({ passphrase });
    expect(wrapped.status).toBe(201);
    expect(wrapped.body).toMatchObject({ version: 1, vaultId: kit.vaultId });
    const imported = await request(ctx.getHttpServer())
      .post('/admin/buddy-backup/key/escrow/import')
      .send({ escrow: wrapped.body, passphrase });
    expect(imported.status).toBe(201);
    expect(buddy.importKit).toHaveBeenCalledWith(kit);
    expect(log.verbose).not.toHaveBeenCalled();
    for (const value of [passphrase, kit.keys[1], wrapped.body.blob]) {
      expect(output()).not.toContain(value);
    }
  });

  it.each(['import', 'verify'])('keeps unwrapped Buddy key/%s maps out of logs', async (operation) => {
    const { status } = await request(ctx.getHttpServer()).post(`/admin/buddy-backup/key/${operation}`).send(kit);
    expect(status).toBe(201);
    expect(log.verbose).not.toHaveBeenCalled();
    expect(output()).not.toContain(kit.keys[1]);
    expect(operation === 'import' ? buddy.importKit : buddy.verifyKit).toHaveBeenCalledWith(kit);
  });

  it('excludes generic credential values at the request boundary', async () => {
    const { status } = await request(ctx.getHttpServer())
      .put('/admin/config/credentials/smtp-password')
      .send({ value: passphrase });
    expect(status).toBe(200);
    expect(config.setCredential).toHaveBeenCalledWith(undefined, ConfigCredential.SmtpPassword, { value: passphrase });
    expect(log.verbose).not.toHaveBeenCalled();
    expect(output()).not.toContain(passphrase);
  });

  it('excludes bodies and private error messages/stacks when escrow fails', async () => {
    const error = new Error(`${passphrase}\n    at Bearer_fixture_secret`);
    Object.defineProperty(error, 'name', { value: 'Bearer_fixture_name' });
    cloud.storeEscrow.mockRejectedValueOnce(error);
    const { status, body } = await request(ctx.getHttpServer()).put('/admin/cloud/backup/escrow').send({ passphrase });
    expect(status).toBe(500);
    expect(log.error).toHaveBeenCalledExactlyOnceWith('Unknown route error\nError');
    expect(log.verbose).not.toHaveBeenCalled();
    expect(output()).not.toContain(passphrase);
    expect(JSON.stringify(body)).not.toContain(passphrase);
    expect(JSON.stringify([body, output()])).not.toContain('Bearer_fixture');
  });

  it('excludes unrecognized nested fields when validation refuses a recovery request', async () => {
    const { status } = await request(ctx.getHttpServer())
      .post('/admin/buddy-backup/key/escrow')
      .send({ passphrase, unexpected: [{ value: 'synthetic-nested-sentinel' }] });
    expect(status).toBe(400);
    expect(buddy.keyring).not.toHaveBeenCalled();
    expect(log.verbose).not.toHaveBeenCalled();
    expect(output()).not.toContain(passphrase);
    expect(output()).not.toContain('synthetic-nested-sentinel');
  });

  it('keeps ordinary backup diagnostics and query redaction useful', async () => {
    const { status } = await request(ctx.getHttpServer())
      .post(`/admin/cloud/backup/verify?pass_phrase=${passphrase}&page=2`)
      .send({ depth: 'sample' });
    expect(status).toBe(200);
    expect(cloud.startVerify).toHaveBeenCalledWith(undefined, { depth: 'sample' });
    expect(log.verbose).toHaveBeenCalledWith(JSON.stringify({ depth: 'sample' }));
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('?pass_phrase=********&page=2 200'));
    expect(output()).not.toContain(passphrase);
  });
});
