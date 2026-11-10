import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PrivateLogsService } from 'src/services/private-logs.service.js';

const admin = { user: { id: 'admin', isAdmin: true }, session: { id: 'session' } } as AuthDto;
const member = { ...admin, user: { ...admin.user, isAdmin: false } };

describe(PrivateLogsService.name, () => {
  it('requires an interactive administrator session', async () => {
    const sut = new PrivateLogsService({} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(sut.authorize(admin, null)).resolves.toBeUndefined();
    await expect(sut.authorize(member, 'lan')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.authorize({ ...admin, session: undefined }, 'lan')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires fresh, matching Frameleaf authority over remote access and rechecks active tails', async () => {
    const getSession = vi.fn().mockResolvedValue({ userId: admin.user.id, authTime: new Date(Date.now() - 60_000) });
    const sessions = { get: vi.fn().mockResolvedValue({ expiresAt: null }) };
    const users = { get: vi.fn().mockResolvedValue(admin.user) };
    const sut = new PrivateLogsService(
      {} as never,
      sessions as never,
      { getSession } as never,
      users as never,
      {} as never,
    );
    await expect(sut.authorizeLive(admin, 'relay')).resolves.toBeUndefined();
    sessions.get.mockResolvedValueOnce(undefined);
    await expect(sut.authorizeLive(admin, 'relay')).rejects.toBeInstanceOf(ForbiddenException);
    getSession.mockResolvedValueOnce({ userId: 'other', authTime: new Date() });
    await expect(sut.authorize(admin, 'wan')).rejects.toBeInstanceOf(ForbiddenException);
    getSession.mockResolvedValueOnce({ userId: admin.user.id, authTime: new Date(Date.now() - 16 * 60_000) });
    await expect(sut.authorize(admin, 'relay')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
