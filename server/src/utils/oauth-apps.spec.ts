import { describe, expect, it } from 'vitest';
import { Permission } from 'src/enum.js';
import {
  OAUTH_APP_SCOPES,
  checkRegisteredRedirectUri,
  checkResource,
  cleanClientName,
  isOAuthAccessToken,
  matchRedirectUri,
  parseScopes,
  scopePermissions,
  verifiedApp,
} from 'src/utils/oauth-apps.js';

const ADMIN_OR_DANGEROUS = [
  Permission.All,
  Permission.AssetDelete,
  Permission.AssetShare,
  Permission.AlbumDelete,
  Permission.AlbumShare,
  Permission.SharedLinkCreate,
  Permission.SessionLock,
  Permission.PinCodeCreate,
  Permission.PinCodeUpdate,
  Permission.AuthChangePassword,
  Permission.ApiKeyCreate,
  Permission.UserUpdate,
  Permission.PartnerCreate,
  Permission.AdminUserRead,
  Permission.SystemConfigRead,
  Permission.AdminConfigRead,
];

describe('oauth-apps', () => {
  it('accepts only the exact Lightroom native return address', () => {
    expect(checkRegisteredRedirectUri('lightroom://net.frameleaf.connect/oauth/callback')).toBe(
      'lightroom://net.frameleaf.connect/oauth/callback',
    );
    for (const uri of [
      'lightroom://net.frameleaf.connect/oauth/callback?x=1',
      'lightroom://elsewhere/oauth/callback',
      'lightroom://net.frameleaf.connect/other',
    ]) {
      expect(checkRegisteredRedirectUri(uri)).toBeNull();
    }
  });

  describe('scopes', () => {
    it('never carry admin, sharing, deleting or sign-in permissions', () => {
      const all = Object.values(OAUTH_APP_SCOPES).flat();
      for (const permission of ADMIN_OR_DANGEROUS) {
        expect(all).not.toContain(permission);
      }
      expect(all.every((permission) => !permission.startsWith('admin'))).toBe(true);
    });

    it('have no scope for Locked items', () => {
      expect(Object.keys(OAUTH_APP_SCOPES).some((scope) => /lock/i.test(scope))).toBe(false);
    });

    it('defaults to seeing the library when no scope is named', () => {
      expect(parseScopes(undefined)).toEqual({ scopes: ['library:read'], unknown: [] });
      expect(parseScopes('')).toEqual({ scopes: ['library:read'], unknown: [] });
    });

    it('splits, dedupes and orders known scopes and reports unknown ones', () => {
      expect(parseScopes('people:read library:read people:read')).toEqual({
        scopes: ['library:read', 'people:read'],
        unknown: [],
      });
      expect(parseScopes('library:read locked:read admin')).toEqual({
        scopes: ['library:read'],
        unknown: ['locked:read', 'admin'],
      });
      expect(parseScopes('constructor __proto__').unknown).toEqual(['constructor', '__proto__']);
      expect(parseScopes(['library:read']).unknown).toHaveLength(1);
    });

    it('maps scopes to permissions and ignores names it does not know', () => {
      expect(scopePermissions(['library:download', 'nope'])).toEqual([Permission.AssetDownload]);
      expect(scopePermissions(['toString'])).toEqual([]);
    });

    it('lets an app that sees the library count it, without reading other accounts (FL-866)', () => {
      const permissions = scopePermissions(['library:read']);
      expect(permissions).toContain(Permission.AssetStatistics);
      expect(permissions).not.toContain(Permission.UserRead);
      expect(permissions).not.toContain(Permission.ServerStatistics);
    });
  });

  describe('checkRegisteredRedirectUri', () => {
    it.each([
      'https://claude.ai/api/mcp/auth_callback',
      'https://example.com/cb?x=1',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:33418/callback',
      'http://[::1]:8080/cb',
      'http://localhost:6274/oauth/callback',
    ])('accepts %s', (uri) => {
      expect(checkRegisteredRedirectUri(uri)).toBe(uri);
    });

    it.each([
      // eslint-disable-next-line unicorn/prefer-https -- plain http to a non-loopback host must be refused
      'http://example.com/cb',
      'http://192.168.1.2/cb',
      'https://user:pass@example.com/cb',
      'https://example.com/cb#frag',
      'https://example.com/a/../b',
      'https://example.com/a%2fb',
      'https://EXAMPLE.com/cb',
      'https://example.com',
      'javascript:alert(1)',
      'myapp://callback',
      'https://example.com/ cb',
      '',
      42,
    ])('refuses %s', (uri) => {
      expect(checkRegisteredRedirectUri(uri)).toBeNull();
    });
  });

  describe('matchRedirectUri', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1234/callback'];

    it('matches exactly', () => {
      expect(matchRedirectUri(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(
        'https://claude.ai/api/mcp/auth_callback',
      );
    });

    it('refuses near misses', () => {
      for (const uri of [
        'https://claude.ai/api/mcp/auth_callback/',
        'https://claude.ai/api/mcp/auth_callback?x=1',
        'https://claude.ai.evil.example/api/mcp/auth_callback',
        'https://claude.ai:444/api/mcp/auth_callback',
        // eslint-disable-next-line unicorn/prefer-https -- the http form of an https address must not match
        'http://claude.ai/api/mcp/auth_callback',
        'HTTPS://claude.ai/api/mcp/auth_callback',
      ]) {
        expect(matchRedirectUri(registered, uri)).toBeNull();
      }
    });

    it('lets a loopback address use any port, and only that', () => {
      expect(matchRedirectUri(registered, 'http://127.0.0.1:5555/callback')).toBe('http://127.0.0.1:5555/callback');
      expect(matchRedirectUri(registered, 'http://127.0.0.1/callback')).toBe('http://127.0.0.1/callback');
      expect(matchRedirectUri(registered, 'http://127.0.0.1:5555/other')).toBeNull();
      expect(matchRedirectUri(registered, 'http://localhost:5555/callback')).toBeNull();
      expect(matchRedirectUri(registered, 'https://claude.ai:5555/api/mcp/auth_callback')).toBeNull();
    });
  });

  describe('verifiedApp', () => {
    it('knows an app only when every return address is its own', () => {
      expect(verifiedApp(['https://claude.ai/api/mcp/auth_callback'])?.name).toBe('Claude');
      expect(verifiedApp(['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'])).toBeNull();
      expect(verifiedApp([])).toBeNull();
    });
  });

  it('cleans an app’s own name', () => {
    expect(cleanClientName('  Claude‮ ')).toBe('Claude');
    expect(cleanClientName('\0')).toBeNull();
    expect(cleanClientName('x'.repeat(200))).toHaveLength(80);
    expect(cleanClientName(5)).toBeNull();
  });

  it('checks resource indicators', () => {
    expect(checkResource(undefined)).toBeNull();
    expect(checkResource('https://home.example/api/mcp')).toBe('https://home.example/api/mcp');
    expect(checkResource('https://home.example/api/mcp#x')).toBe(false);
    expect(checkResource('ftp://home.example')).toBe(false);
  });

  it('tells app tokens from session tokens', () => {
    expect(isOAuthAccessToken('fla_abc')).toBe(true);
    expect(isOAuthAccessToken('abc')).toBe(false);
    expect(isOAuthAccessToken(null)).toBe(false);
  });
});
