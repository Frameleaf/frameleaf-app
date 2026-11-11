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

  it('requires a recent Frameleaf or passkey sign-in over remote access and rechecks active tails', async () => {
    const signedIn = (source: 'local' | 'frameleaf', methods: string[], ageMs: number) => ({
      ...admin,
      session: {
        ...admin.session!,
        signIn: { methods, level: 'basic' as const, source, legacy: false, authTime: new Date(Date.now() - ageMs) },
      },
    });
    const sessions = { get: vi.fn().mockResolvedValue({ expiresAt: null }) };
    const users = { get: vi.fn().mockResolvedValue(admin.user) };
    const sut = new PrivateLogsService({} as never, sessions as never, {} as never, users as never, {} as never);
    const recent = signedIn('frameleaf', ['email_code'], 60_000);
    await expect(sut.authorizeLive(recent, 'relay')).resolves.toBeUndefined();
    sessions.get.mockResolvedValueOnce(undefined);
    await expect(sut.authorizeLive(recent, 'relay')).rejects.toBeInstanceOf(ForbiddenException);
    // older than 10 minutes, or not a Frameleaf or passkey sign-in at all
    await expect(sut.authorize(signedIn('frameleaf', [], 11 * 60_000), 'relay')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(sut.authorize(signedIn('local', ['pwd'], 1000), 'wan')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.authorize(signedIn('local', ['passkey'], 1000), 'wan')).resolves.toBeUndefined();
    await expect(sut.authorize(admin, 'relay')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
