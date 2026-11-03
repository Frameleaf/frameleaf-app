import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from 'src/commands/migrate/controller';
import type { Ledger } from 'src/commands/migrate/ledger';
import { type Dashboard, startDashboard } from 'src/commands/migrate/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** fetch never lets a caller set Host, so a rebinding page's request is made with node:http. */
const requestWithHost = (url: string, host: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<number>((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url);
    request({ hostname, port, path: pathname, method, headers: { ...headers, host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    })
      .on('error', reject)
      .end();
  });

const statusOf = async (input: string, init?: RequestInit) => {
  const response = await fetch(input, init);
  return response.status;
};

describe('migration dashboard', () => {
  let dir: string;
  let dashboard: Dashboard;
  let token: string;
  let base: string;
  const controller = new Controller();
  const ledger = { counts: () => ({ assetsTotal: 3, assetsUploaded: 1 }) } as unknown as Ledger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-migrate-dashboard-'));
    await writeFile(join(dir, 'audit.json'), JSON.stringify({ generatedAt: 'now', ok: true }));
    dashboard = await startDashboard(
      0,
      controller,
      ledger,
      { from: 'https://a.example', to: 'https://b.example', user: 'taylor@example.com' },
      join(dir, 'audit.json'),
      false,
    );
    const url = new URL(dashboard.url);
    token = url.searchParams.get('t')!;
    base = url.origin;
  });

  afterEach(async () => {
    dashboard.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('prints a loopback URL on the bound port that carries the token', () => {
    expect(dashboard.url).toBe(`http://127.0.0.1:${dashboard.port}/?t=${token}`);
    expect(token).toMatch(/^[\da-f]{32}$/);
  });

  it('serves the page to anyone on loopback, but /status and /audit only with the token', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Frameleaf migration');

    expect(await statusOf(`${base}/status`)).toBe(403);
    expect(await statusOf(`${base}/audit`)).toBe(403);
    expect(await statusOf(`${base}/status`, { headers: { 'x-migrate-token': 'wrong' } })).toBe(403);

    const status = await fetch(`${base}/status`, { headers: { 'x-migrate-token': token } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ user: 'taylor@example.com', counts: { assetsTotal: 3 } });
    const audit = await fetch(`${base}/audit`, { headers: { 'x-migrate-token': token } });
    expect(await audit.json()).toEqual({ generatedAt: 'now', ok: true });
  });

  it('refuses every request whose Host is not this loopback server (DNS rebinding)', async () => {
    const withToken = { 'x-migrate-token': token };
    for (const path of ['/', '/status', '/audit']) {
      expect(await requestWithHost(`${base}${path}`, 'attacker.example', withToken), path).toBe(403);
      expect(await requestWithHost(`${base}${path}`, `attacker.example:${dashboard.port}`, withToken), path).toBe(403);
    }
    expect(await requestWithHost(`${base}/pause`, `attacker.example:${dashboard.port}`, withToken, 'POST')).toBe(403);
    expect(controller.paused).toBe(false);
    for (const host of [`localhost:${dashboard.port}`, `127.0.0.1:${dashboard.port}`, `[::1]:${dashboard.port}`]) {
      expect(await requestWithHost(`${base}/status`, host, withToken), host).toBe(200);
    }
    // the port is part of it: another loopback server's page is another origin
    expect(await requestWithHost(`${base}/status`, `127.0.0.1:${dashboard.port + 1}`, withToken)).toBe(403);
  });

  it('controls need the token in the header; the page does not keep it in the address bar', async () => {
    expect(await statusOf(`${base}/pause`, { method: 'POST' })).toBe(403);
    expect(await statusOf(`${base}/pause?t=${token}`, { method: 'POST' })).toBe(403);
    expect(controller.paused).toBe(false);
    expect(await statusOf(`${base}/pause`, { method: 'POST', headers: { 'x-migrate-token': token } })).toBe(204);
    expect(controller.paused).toBe(true);
    expect(await statusOf(`${base}/resume`, { method: 'POST', headers: { 'x-migrate-token': token } })).toBe(204);
    expect(controller.paused).toBe(false);
    const response = await fetch(`${base}/?t=${token}`);
    const page = await response.text();
    expect(page).toContain('history.replaceState');
    expect(page).toContain("fetch('/status',opts)");
  });

  it('answers 404 for other paths once the token is given', async () => {
    expect(await statusOf(`${base}/nothing`, { headers: { 'x-migrate-token': token } })).toBe(404);
  });
});
