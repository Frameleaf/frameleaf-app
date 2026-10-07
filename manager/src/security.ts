import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import { Refusal, sha256 } from './contracts.js';
import { Store } from './store.js';

const scrypt = promisify(derive);
const token = () => randomBytes(32).toString('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const COOKIE = '__Host-frameleaf-manager';
const LIFETIME = 8 * 60 * 60 * 1000;

export class Security {
  constructor(
    private store: Store,
    readonly origin: string,
    private bootstrapFile: string,
  ) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error('Invalid Manager HTTPS origin');
    this.origin = url.origin;
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
  async claim(name: string, password: string, proof: string): Promise<void> {
    if (this.claimed()) throw new Refusal('already_claimed');
    // A LAN visitor cannot win a first-request race: proof must be read from the private mounted file.
    const expected = readFileSync(this.bootstrapFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(proof) || !same(expected, proof)) throw new Refusal('invalid_claim_proof', 401);
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
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      });
      // Host equality rejects DNS rebinding, including on read-only endpoints. Never trust proxy headers.
      if (req.headers.host !== new URL(this.origin).host) throw new Refusal('invalid_host', 403);
      if (!req.path.startsWith('/manager-api/')) return next();
      const write = !['GET', 'HEAD'].includes(req.method);
      const publicRoute = ['/manager-api/status', '/manager-api/claim', '/manager-api/login'].includes(req.path);
      const credential = ['administrator', 'backup-key', 'export'].some((path) => req.path === `/manager-api/${path}`);
      this.limit(req.socket.remoteAddress ?? 'unknown', write && (publicRoute || credential) ? 'login' : 'api');
      if (write && (req.headers.origin !== this.origin || !req.is('application/json')))
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
