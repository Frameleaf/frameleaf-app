import { Permission, type SessionResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  canSubmitPin,
  keyPurpose,
  PURPOSE_PERMISSIONS,
  filterPermissions,
  INDIVIDUAL_PERMISSIONS,
  KEY_PURPOSES,
  isCompletePin,
  isProfileImageFile,
  keyCanDelete,
  normalizeKeyPermissions,
  otherSessions,
  passwordFormError,
  providerAccountLink,
  sessionDeviceName,
  sortSessions,
  summarizePermissions,
} from '$lib/frameleaf/personal-access';

const session = (overrides: Partial<SessionResponseDto>): SessionResponseDto => ({
  id: 'session',
  appVersion: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  current: false,
  deviceOS: 'macOS',
  deviceType: 'Safari',
  isPendingSyncReset: false,
  ...overrides,
});

describe('personal access (FL-67)', () => {
  describe('password change', () => {
    const valid = { current: 'old-password', next: 'new-password', confirm: 'new-password' };

    it('accepts a new, confirmed password of at least eight characters', () => {
      expect(passwordFormError(valid)).toBeUndefined();
    });

    it('explains what is missing or wrong', () => {
      expect(passwordFormError({ ...valid, current: '' })).toBe('required');
      expect(passwordFormError({ current: 'old-password', next: 'short', confirm: 'short' })).toBe('too_short');
      expect(passwordFormError({ ...valid, confirm: 'new-passw0rd' })).toBe('mismatch');
      expect(passwordFormError({ current: 'same-password', next: 'same-password', confirm: 'same-password' })).toBe(
        'unchanged',
      );
    });
  });

  describe('PIN forms', () => {
    const empty = { current: '', next: '', confirm: '', password: '' };

    it('recognises a complete six-digit PIN only', () => {
      expect(isCompletePin('123456')).toBe(true);
      expect(isCompletePin('12345')).toBe(false);
      expect(isCompletePin('12345a')).toBe(false);
    });

    it('needs a confirmed new PIN to create one', () => {
      expect(canSubmitPin('create', { ...empty, next: '123456', confirm: '123456' })).toBe(true);
      expect(canSubmitPin('create', { ...empty, next: '123456', confirm: '654321' })).toBe(false);
    });

    it('needs the current PIN to change or clear it', () => {
      expect(canSubmitPin('change', { ...empty, current: '111111', next: '123456', confirm: '123456' })).toBe(true);
      expect(canSubmitPin('change', { ...empty, next: '123456', confirm: '123456' })).toBe(false);
      expect(canSubmitPin('clear', { ...empty, current: '111111' })).toBe(true);
      expect(canSubmitPin('clear', empty)).toBe(false);
    });

    it('needs the account password to reset a forgotten PIN', () => {
      expect(canSubmitPin('reset', { ...empty, password: 'secret' })).toBe(true);
      expect(canSubmitPin('reset', { ...empty, current: '111111' })).toBe(false);
    });
  });

  describe('API key permissions', () => {
    it('sends full access as all, and every individual permission as all', () => {
      expect(normalizeKeyPermissions([Permission.All, Permission.AssetRead])).toEqual([Permission.All]);
      expect(normalizeKeyPermissions([...INDIVIDUAL_PERMISSIONS])).toEqual([Permission.All]);
    });

    it('keeps a partial choice as it is, without duplicates', () => {
      expect(normalizeKeyPermissions([Permission.AssetRead, Permission.AssetRead, Permission.AlbumRead])).toEqual([
        Permission.AssetRead,
        Permission.AlbumRead,
      ]);
    });

    it('warns about keys that can delete', () => {
      expect(keyCanDelete([Permission.All])).toBe(true);
      expect(keyCanDelete([Permission.AssetDelete])).toBe(true);
      expect(keyCanDelete([Permission.AssetRead])).toBe(false);
    });

    it('filters permissions by name with full access first', () => {
      expect(filterPermissions('')[0]).toBe(Permission.All);
      expect(filterPermissions('asset.read')).toContain(Permission.AssetRead);
      expect(filterPermissions('asset.read')).not.toContain(Permission.AlbumRead);
    });

    it('summarises long permission lists', () => {
      const permissions = [Permission.AssetRead, Permission.AlbumRead, Permission.TagRead, Permission.PersonRead];
      expect(summarizePermissions(permissions, 2)).toEqual({ shown: permissions.slice(0, 2), more: 2 });
    });
  });

  describe('signed-in devices', () => {
    const current = session({ id: 'current', current: true, updatedAt: '2026-09-01T00:00:00.000Z' });
    const recent = session({ id: 'recent', updatedAt: '2026-09-20T00:00:00.000Z' });
    const old = session({ id: 'old', updatedAt: '2026-01-20T00:00:00.000Z' });

    it('lists this device first, then the most recently active', () => {
      expect(sortSessions([old, recent, current]).map(({ id }) => id)).toEqual(['current', 'recent', 'old']);
    });

    it('signs out only the other devices', () => {
      expect(otherSessions([current, recent, old]).map(({ id }) => id)).toEqual(['recent', 'old']);
    });

    it('names a device from what it reported', () => {
      expect(sessionDeviceName(recent, 'Unknown device')).toBe('macOS · Safari');
      expect(sessionDeviceName(session({ deviceOS: '', deviceType: '' }), 'Unknown device')).toBe('Unknown device');
    });
  });

  it('opens a provider account page only for an http(s) address', () => {
    expect(providerAccountLink('https://id.example.com/account')).toBe('https://id.example.com/account');
    expect(providerAccountLink('javascript:alert(1)')).toBeUndefined();
    expect(providerAccountLink('')).toBeUndefined();
    expect(providerAccountLink(undefined)).toBeUndefined();
  });

  it('accepts only photo files the server takes as a profile photo', () => {
    expect(isProfileImageFile({ name: 'me.JPG', size: 1000 })).toBe(true);
    expect(isProfileImageFile({ name: 'me.heic', size: 1000 })).toBe(true);
    expect(isProfileImageFile({ name: 'me.gif', size: 1000 })).toBe(false);
    expect(isProfileImageFile({ name: 'me.png', size: 0 })).toBe(false);
  });
});

describe('API key purposes (FL-367)', () => {
  it('keeps browser capture limited to its own capture and destination catalog operations', () => {
    expect(PURPOSE_PERMISSIONS.capture).toEqual([Permission.CaptureCreate, Permission.CaptureCatalogRead]);
    expect(keyPurpose([...PURPOSE_PERMISSIONS.capture])).toBe('capture');
    expect(keyPurpose([...PURPOSE_PERMISSIONS.capture, Permission.AssetRead])).toBe('custom');
    for (const permission of [
      Permission.AssetRead,
      Permission.AssetView,
      Permission.AssetUpload,
      Permission.AssetDelete,
      Permission.TagCreate,
      Permission.AlbumShare,
      Permission.All,
    ]) {
      expect(PURPOSE_PERMISSIONS.capture).not.toContain(permission);
    }
    expect(keyCanDelete([...PURPOSE_PERMISSIONS.capture])).toBe(false);
  });
  it('offers the browser extension just before Everything, as ApiKeys.jsx does', () => {
    expect(KEY_PURPOSES).toEqual(['view', 'upload', 'view-upload', 'capture', 'everything']);
  });
  it('recognises a purpose from its exact permissions, and anything else as your own choice', () => {
    expect(keyPurpose([...PURPOSE_PERMISSIONS.view])).toBe('view');
    expect(keyPurpose([Permission.AssetUpload])).toBe('upload');
    expect(keyPurpose([Permission.All])).toBe('everything');
    expect(keyPurpose([Permission.AssetRead])).toBe('custom');
  });

  it('keeps downloads and deletes out of View only', () => {
    expect(PURPOSE_PERMISSIONS.view).not.toContain(Permission.AssetDownload);
    expect(PURPOSE_PERMISSIONS.view.some((permission) => permission.endsWith('.delete'))).toBe(false);
  });
});
