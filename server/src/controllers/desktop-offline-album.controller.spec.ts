import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { offlineAlbumHost } from 'src/controllers/desktop-offline-album.controller.js';

const browser = { host: '127.0.0.1:2283', origin: 'http://127.0.0.1:2283', cookie: 'immich_access_token=synthetic' };
const request = (headers: Request['headers'], peer = '127.0.0.1', query = {}) =>
  ({ headers, socket: { remoteAddress: peer }, query }) as Request;

describe('offline album handoff origin', () => {
  it('requires a same-origin browser cookie from the exact loopback connection', () => {
    expect(offlineAlbumHost(request(browser, '::ffff:127.0.0.1'), true)).toBe(browser.host);
    expect(() => offlineAlbumHost(request(browser, '10.0.0.1'), true)).toThrow(NotFoundException);
    expect(() => offlineAlbumHost(request({ ...browser, origin: 'http://127.0.0.1:2284' }), true)).toThrow(
      NotFoundException,
    );
    expect(() => offlineAlbumHost(request({ ...browser, authorization: 'Bearer synthetic' }), true)).toThrow(
      NotFoundException,
    );
    expect(() => offlineAlbumHost(request(browser, undefined, { key: 'synthetic' }), true)).toThrow(NotFoundException);
  });
  it('keeps web cookies, web origins, proxy hosts and general bearer tokens off native routes', () => {
    expect(offlineAlbumHost(request({ host: browser.host }), false)).toBe(browser.host);
    for (const headers of [
      browser,
      { host: 'localhost:2283' },
      { host: browser.host, authorization: 'Bearer synthetic' },
    ]) {
      expect(() => offlineAlbumHost(request(headers), false)).toThrow(NotFoundException);
    }
  });
});
