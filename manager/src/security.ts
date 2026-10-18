import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import { Refusal, sha256 } from './contracts.js';
import { Store } from './store.js';

const scrypt = promisify(derive);
const token = () => randomBytes(32).toString('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const COOKIE = '__Host-frameleaf-manager';
const LIFETIME = 8 * 60 * 60 * 1000;
// Without a configured origin, only names public DNS cannot point at this host are trusted (no rebinding).
const localHost = (hostname: string) =>
  isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 || hostname === 'localhost' || hostname.endsWith('.local') || !hostname.includes('.');
// Claiming needs no code (owner 2026-10-14, as on the server): only the home network, only while unclaimed.
// 100.64/10 (CGNAT, Tailscale) is remote access, not home.
const home = new BlockList();
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16]] as const)
  home.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]] as const) home.addSubnet(address, prefix, 'ipv6');
export const homeAddress = (address: string | undefined) => {
  const ip = address?.replace(/^::ffff:(?=\d+\.)/, '') ?? '';
  const family = isIP(ip);
  return family !== 0 && home.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};

export class Security {
  private readonly frameAncestors: string;
  constructor(
    private store: Store,
    readonly origin: string | undefined,
    frameOrigin?: string,
  ) {
    this.frameAncestors = "'none'";
    if (!origin) {
      if (frameOrigin) throw new Error('A frame origin requires MANAGER_ORIGIN');
      return;
    }
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error('Invalid Manager HTTPS origin');
    this.origin = url.origin;
    if (frameOrigin) {
      const frame = new URL(frameOrigin);
      if (
        frame.protocol !== 'https:' || frame.pathname !== '/' || frame.search || frame.hash ||
        frame.username || frame.password || frame.hostname !== url.hostname
      ) throw new Error('Frame origin must be an exact HTTPS origin on the Manager hostname');
      this.frameAncestors = frame.origin;
    }
  }
  /** The configured origin, or the local address the browser used when none is configured. */
  requestOrigin(req: Request): string {
    if (this.origin) {
      if (req.headers.host !== new URL(this.origin).host) throw new Refusal('invalid_host', 403);
      return this.origin;
    }
    let url: URL;
    try {
      url = new URL(`https://${req.headers.host}`);
    } catch {
      throw new Refusal('invalid_host', 403);
    }
    if (url.host !== req.headers.host || !localHost(url.hostname)) throw new Refusal('invalid_host', 403);
    return url.origin;
  }
  claimed(): boolean {
    return !!this.store.get('administrator');
  }
  limit(address: string, scope = 'login'): void {
    const key = sha256(`${scope}:${address}`),
      now = Date.now();
    this.store.db.prepare('DELETE FROM attempts WHERE until < ?').run(now);
    this.store.db
      .prepare(`INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1`)
      .run(key, now + 600_000);
    const { count } = this.store.db.prepare('SELECT count FROM attempts WHERE key=?').get(key) as { count: number };
    if (count > (scope === 'login' ? 10 : 120)) throw new Refusal('rate_limited', 429);
  }
  async claim(name: string, password: string, address: string | undefined): Promise<void> {
    if (this.claimed()) throw new Refusal('already_claimed');
    if (!homeAddress(address)) throw new Refusal('claim_lan_only', 403);
    const salt = token(),
      hash = ((await scrypt(password, salt, 64)) as Buffer).toString('hex');
    if (!this.store.createOnce('administrator', { name, salt, hash })) throw new Refusal('already_claimed');
  }
  async login(password: string): Promise<{ session: string; csrf: string }> {
    const verified = await this.confirm(password);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (JSON.stringify(verified) !== JSON.stringify(this.store.get('administrator')))
        throw new Refusal('invalid_credentials', 401);
      const session = this.createSession();
      this.store.db.exec('COMMIT');
      return session;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  private createSession(): { session: string; csrf: string } {
    const session = token(),
      csrf = token();
    this.store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha256(session), csrf, Date.now() + LIFETIME);
    return { session, csrf };
  }
  async confirm(password: string): Promise<{ name: string; salt: string; hash: string }> {
    const admin = this.store.get<{ name: string; salt: string; hash: string }>('administrator');
    const hash = ((await scrypt(password, admin?.salt ?? 'unclaimed-manager', 64)) as Buffer).toString('hex');
    if (!admin || !same(admin.hash, hash) || JSON.stringify(admin) !== JSON.stringify(this.store.get('administrator')))
      throw new Refusal('invalid_credentials', 401);
    return admin;
  }
  async updateAdministrator(name: string, password: string, newPassword?: string) {
    const previous = await this.confirm(password);
    const salt = newPassword ? token() : previous.salt;
    const hash = newPassword ? ((await scrypt(newPassword, salt, 64)) as Buffer).toString('hex') : previous.hash;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.store.db
        .prepare('UPDATE settings SET value=? WHERE key=? AND value=?')
        .run(JSON.stringify({ name, salt, hash }), 'administrator', JSON.stringify(previous));
      if (result.changes !== 1) throw new Refusal('invalid_credentials', 401);
      this.store.db.exec('DELETE FROM sessions');
      const session = this.createSession();
      this.store.db.exec('COMMIT');
      return session;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  cookie(res: Response, session: string): void {
    res.cookie(COOKIE, session, { secure: true, httpOnly: true, sameSite: 'strict', path: '/', maxAge: LIFETIME });
  }
  session(req: Request): { hash: string; csrf: string } {
    const value = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Refusal('sign_in_required', 401);
    const hash = sha256(value);
    const found = this.store.db
      .prepare('SELECT csrf FROM sessions WHERE hash=? AND expires>?')
      .get(hash, Date.now()) as { csrf: string } | undefined;
    if (!found) throw new Refusal('sign_in_required', 401);
    return { hash, csrf: found.csrf };
  }
  logout(req: Request, res: Response): void {
    this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(this.session(req).hash);
    res.clearCookie(COOKIE, { secure: true, httpOnly: true, sameSite: 'strict', path: '/' });
  }
  guard = (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.set({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${this.frameAncestors}; base-uri 'none'; form-action 'self'`,
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      });
      // Host equality rejects DNS rebinding, including on read-only endpoints. Never trust proxy headers.
      const origin = this.requestOrigin(req);
      // Express route matching is case-insensitive unless explicitly configured otherwise.
      if (req.path.toLowerCase().startsWith('/manager-api/') && req.path !== req.path.toLowerCase())
        throw new Refusal('invalid_api_path', 403);
      if (!req.path.startsWith('/manager-api/')) return next();
      const write = !['GET', 'HEAD'].includes(req.method);
      const publicRoute = ['/manager-api/status', '/manager-api/claim', '/manager-api/login'].includes(req.path);
      const credential = ['administrator', 'backup-key', 'export'].some((path) => req.path === `/manager-api/${path}`);
      this.limit(req.socket.remoteAddress ?? 'unknown', write && (publicRoute || credential) ? 'login' : 'api');
      if (write && (req.headers.origin !== origin || !req.is('application/json')))
        throw new Refusal('invalid_origin', 403);
      if (!publicRoute) {
        const session = this.session(req);
        if (write && !same(session.csrf, String(req.headers['x-csrf-token'] ?? '')))
          throw new Refusal('invalid_csrf', 403);
      }
      next();
    } catch (e) {
      const error = e instanceof Refusal ? e : new Refusal('request_refused', 400);
      res.status(error.status).json({ code: error.code });
    }
  };
}
