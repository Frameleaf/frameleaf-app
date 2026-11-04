import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const normalizeAddress = (address: string | undefined) => address?.trim().replace(/^::ffff:(?=\d+\.)/, '') ?? '';
export const homeAddress = (address: string | undefined) => {
  const ip = normalizeAddress(address);
  const family = isIP(ip);
  return family !== 0 && home.check(ip, family === 4 ? 'ipv4' : 'ipv6');
};
const isLoopback = (address: string | undefined) => {
  const ip = normalizeAddress(address);
  return ip === '::1' || /^127\./.test(ip);
};
/**
 * The container's default IPv4 gateway from /proc/net/route: Docker's bridge gateway. Connections that
 * Docker's userland proxy or a host reverse proxy forwards arrive from this address, whatever network the
 * real client is on. Null when there is no default route (native runtime, host networking) or it is unreadable.
 */
export function defaultGateway(route = '/proc/net/route'): string | null {
  let table: string;
  try {
    table = readFileSync(route, 'utf8');
  } catch {
    return null;
  }
  for (const line of table.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway ?? '')) continue;
    const bytes = Buffer.from(gateway, 'hex');
    return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
  }
  return null;
}
/** Comma, space or colon separated IPv4/IPv6 addresses or CIDR prefixes of proxies whose X-Forwarded-For is trusted. */
export function trustedProxyList(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}
export type NetworkOptions = {
  /** Proxies allowed to set X-Forwarded-For; empty means the TCP peer is always the client. */
  trustedProxies?: string[];
  /**
   * Manager's own port is published on loopback only, so the bridge gateway can only carry host-local clients.
   * A host process is still one of them: a reverse proxy on this host that is not declared in `trustedProxies`
   * forwards remote clients to the loopback port and they arrive as the gateway, so this does not stop remote
   * access through such a proxy; declare the proxy, or complete the initial claim before exposing Manager.
   */
  loopbackPublished?: boolean;
  /** The bridge gateway address; replaces /proc/net/route detection in tests. */
  bridgeGateway?: () => string | null;
};
const ATTEMPTS: Record<string, number> = { login: 10, confirm: 20, redeem: 10 };

export class Security {
  private readonly frameAncestors: string;
  private readonly secure: boolean;
  private readonly trusted = new BlockList();
  private readonly trustedProxies: string[];
  private readonly loopbackPublished: boolean;
  private readonly detectGateway: () => string | null;
  private gateway: string | null | undefined;
  constructor(
    private store: Store,
    readonly origin: string | undefined,
    frameOrigin?: string,
    network: NetworkOptions = {},
  ) {
    this.trustedProxies = network.trustedProxies ?? [];
    for (const entry of this.trustedProxies) {
      const [address, prefix] = entry.split('/');
      const ip = normalizeAddress(address);
      const family = isIP(ip);
      const bits = prefix === undefined ? undefined : Number(prefix);
      if (
        family === 0 ||
        (bits !== undefined && (!/^\d{1,3}$/.test(prefix) || bits > (family === 4 ? 32 : 128)))
      )
        throw new Error(`Invalid MANAGER_TRUSTED_PROXIES entry: ${entry}`);
      if (bits === undefined) this.trusted.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
      else this.trusted.addSubnet(ip, bits, family === 4 ? 'ipv4' : 'ipv6');
    }
    this.loopbackPublished = network.loopbackPublished ?? false;
    this.detectGateway = network.bridgeGateway ?? defaultGateway;
    this.frameAncestors = "'none'";
    this.secure = !origin || new URL(origin).protocol !== 'http:';
    if (!origin) {
      if (frameOrigin) throw new Error('A frame origin requires MANAGER_ORIGIN');
      return;
    }
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new Error('Invalid Manager HTTP or HTTPS origin');
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
  requireImportBootstrapTransport(request: Pick<Request, 'secure'>): void {
    const secure = this.origin ? this.origin.startsWith('https://') : request.secure;
    if (!secure) throw new Refusal('import_bootstrap_secure_transport_required');
  }
  claimed(): boolean {
    return !!this.store.get('administrator');
  }
  private trustedProxy(address: string): boolean {
    const family = isIP(address);
    return family !== 0 && this.trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
  }
  /**
   * The client's address: the TCP peer, or, when that peer is a configured trusted proxy, the rightmost
   * X-Forwarded-For hop that no trusted proxy added. Without MANAGER_TRUSTED_PROXIES the header is ignored.
   */
  clientAddress(req: Pick<Request, 'socket' | 'headers'>): string {
    const peer = normalizeAddress(req.socket?.remoteAddress);
    if (!peer) return 'unknown';
    if (!this.trustedProxies.length || !this.trustedProxy(peer)) return peer;
    const header = req.headers['x-forwarded-for'];
    const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((hop) => normalizeAddress(hop))
      .filter((hop) => isIP(hop) !== 0);
    for (let index = hops.length - 1; index >= 0; index--) if (!this.trustedProxy(hops[index])) return hops[index];
    return peer;
  }
  /**
   * A connection from the bridge gateway came through Docker's userland proxy, NAT or a host reverse proxy,
   * so its real origin is unknown: it is not evidence of the home network unless Manager's port is published
   * on loopback only (then only this host can reach it) or a trusted proxy supplied the client address.
   * Limitation: a loopback-only publish proves the connection came from this host, not that the client did. A
   * reverse proxy on the host that MANAGER_TRUSTED_PROXIES does not name forwards remote requests to the
   * loopback port without a validated client address (its headers are ignored or may be absent), and the
   * claim then passes as local. Operators who front Manager with a proxy must declare it so the client
   * address is validated, or complete the initial claim before exposing Manager through the proxy.
   */
  gatewayUnverified(address: string | undefined): boolean {
    if (this.loopbackPublished) return false;
    this.gateway ??= this.detectGateway();
    return !!this.gateway && normalizeAddress(address) === this.gateway;
  }
  limit(address: string, scope = 'login'): void {
    const key = sha256(`${scope}:${address}`),
      now = Date.now();
    this.store.db.prepare('DELETE FROM attempts WHERE until < ?').run(now);
    this.store.db
      .prepare(`INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1`)
      .run(key, now + 600_000);
    const { count } = this.store.db.prepare('SELECT count FROM attempts WHERE key=?').get(key) as { count: number };
    if (count > (ATTEMPTS[scope] ?? 120)) throw new Refusal('rate_limited', 429);
  }
  async claim(name: string, password: string, address: string | undefined): Promise<void> {
    if (this.claimed()) throw new Refusal('already_claimed');
    if (!homeAddress(address)) throw new Refusal('claim_lan_only', 403);
    if (this.gatewayUnverified(address)) {
      console.error(
        `manager: refused to create the administrator from ${normalizeAddress(address)}: that is this container's gateway, so the request came through Docker's proxy or a reverse proxy and its real origin is unknown. Publish Manager directly on a LAN address, set MANAGER_TRUSTED_PROXIES to the proxy, or publish it on 127.0.0.1 only (MANAGER_BIND_ADDRESS=127.0.0.1).`,
      );
      throw new Refusal('claim_proxied_address_unverified', 403);
    }
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
  issueSession(res: Response, session: string): void {
    // Cookies cross ports; HTTP credentials must be sent explicitly only to Manager's origin.
    if (!this.secure) res.set('X-Frameleaf-Manager-Session', session);
    else res.cookie(COOKIE, session, { secure: true, httpOnly: true, sameSite: 'strict', path: '/', maxAge: LIFETIME });
  }
  private signedIn(req: Request): boolean {
    try {
      return !!this.session(req);
    } catch {
      return false;
    }
  }
  session(req: Request): { hash: string; csrf: string } {
    const value = !this.secure ? req.headers['x-frameleaf-manager-session'] : (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Refusal('sign_in_required', 401);
    const hash = sha256(value);
    const found = this.store.db
      .prepare('SELECT csrf FROM sessions WHERE hash=? AND expires>?')
      .get(hash, Date.now()) as { csrf: string } | undefined;
    if (!found) throw new Refusal('sign_in_required', 401);
    return { hash, csrf: found.csrf };
  }
  logout(req: Request, res: Response): void {
    this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(this.session(req).hash);
    if (this.secure) res.clearCookie(COOKIE, { secure: true, httpOnly: true, sameSite: 'strict', path: '/' });
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
      const client = this.clientAddress(req);
      const signedIn = this.signedIn(req);
      // A signed-in session's own calls (the UI polls dashboard every 10 s) never spend the anonymous budget;
      // its password confirmations (export, backup key, administrator) have a per-session budget of their own,
      // so ten downloads from one workstation cannot lock that address out of signing in.
      if (write && publicRoute) this.limit(client, 'login');
      else if (write && credential) {
        if (signedIn) this.limit(this.session(req).hash, 'confirm');
        else this.limit(client, 'login');
      } else if (!signedIn) this.limit(client, 'api');
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
