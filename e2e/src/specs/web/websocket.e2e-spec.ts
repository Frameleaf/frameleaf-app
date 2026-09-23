import { LoginResponseDto } from '@immich/sdk';
import { expect, type Page, test } from '@playwright/test';
import { utils } from 'src/utils.js';

/**
 * The library no longer carries a server status line in its rail (the prototype moved system status
 * to Settings), so the connection is observed directly: the socket.io upgrade must open and receive
 * the server's handshake frame.
 */
const expectSocketConnects = async (page: Page, url: string) => {
  const socketPromise = page.waitForEvent('websocket', (socket) => socket.url().includes('/api/socket.io'));
  await page.goto(url);
  const socket = await socketPromise;
  // engine.io's open packet ("0{…sid…}") arrives first on a successful connection.
  const frame = await socket.waitForEvent('framereceived', (event) => String(event.payload).startsWith('0'));
  expect(String(frame.payload)).toContain('"sid"');
  expect(socket.isClosed()).toBe(false);
};

test.describe('Websocket', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('connects using ipv4', async ({ page, context }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await expectSocketConnects(page, 'http://127.0.0.1:2285/');
  });

  test('connects using ipv6', async ({ page, context }) => {
    await utils.setAuthCookies(context, admin.accessToken, '[::1]');
    await expectSocketConnects(page, 'http://[::1]:2285/');
  });
});
