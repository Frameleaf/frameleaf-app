import { allowedOrigins, requestHosts, websocketOriginAllowed } from 'src/utils/websocket-origin.js';

describe('websocket origin allow-list (FL-161)', () => {
  const origins = allowedOrigins([
    'https://photos.example.com/',
    'https://r.k3v9.frameleaf-direct.net',
    null,
    '',
    'not a url',
    'ftp://files.example.com',
  ]);
  const hosts = requestHosts({ host: '192.168.1.10:2283' });

  it('normalizes the configured origins and drops what is not an http address', () => {
    expect(origins).toEqual(['https://photos.example.com', 'https://r.k3v9.frameleaf-direct.net']);
  });

  it('accepts a page on the address the request was sent to', () => {
    expect(websocketOriginAllowed('http://192.168.1.10:2283', { hosts, origins })).toBe(true);
  });

  it('accepts the external domain and the published Frameleaf names', () => {
    expect(websocketOriginAllowed('https://photos.example.com', { hosts, origins })).toBe(true);
    expect(websocketOriginAllowed('https://r.k3v9.frameleaf-direct.net', { hosts, origins })).toBe(true);
  });

  it('accepts the host a reverse proxy forwarded', () => {
    const proxied = requestHosts({ host: 'immich-server:2283', 'x-forwarded-host': 'Photos.Home.Lan' });
    expect(websocketOriginAllowed('https://photos.home.lan', { hosts: proxied, origins: [] })).toBe(true);
  });

  it('refuses any other page, a null origin and a look-alike', () => {
    expect(websocketOriginAllowed('https://evil.example', { hosts, origins })).toBe(false);
    expect(websocketOriginAllowed('null', { hosts, origins })).toBe(false);
    expect(websocketOriginAllowed('https://photos.example.com.evil.example', { hosts, origins })).toBe(false);
    // eslint-disable-next-line unicorn/prefer-https -- the page's own host over plain HTTP is another origin, refused
    expect(websocketOriginAllowed('http://photos.example.com', { hosts, origins })).toBe(false);
    expect(websocketOriginAllowed('http://192.168.1.10:9999', { hosts, origins })).toBe(false);
  });

  it('leaves a handshake without an origin (an app, not a web page) to authentication', () => {
    expect(websocketOriginAllowed(undefined, { hosts, origins })).toBe(true);
  });
});
