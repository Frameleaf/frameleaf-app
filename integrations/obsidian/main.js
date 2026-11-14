'use strict';
// Frameleaf Images for Obsidian. Plain CommonJS so the source is the release file; see README.md.
const obsidian = require('obsidian');
const { createHash, randomBytes, timingSafeEqual } = require('crypto');
const http = require('http');

const JSON_LIMIT = 1 << 20;
const THUMBNAIL_LIMIT = 2 << 20;
const IMAGE_LIMIT = 16 << 20;
const CALLBACK_TTL = 300_000;
const SCOPE = 'library:read';
const VARIANT = 'preview';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

const fail = (code) => Object.assign(new Error(code), { code });

function language() {
  const code = String(obsidian.getLanguage?.() ?? 'en').toLowerCase();
  return code === 'no' ? 'nb' : code.split('-')[0];
}
function t(key, vars = {}) {
  const text =
    (MESSAGES[language()] ?? MESSAGES.en)[key] ??
    MESSAGES.en[key] ??
    MESSAGES.en.connection_failed;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

/** A Library origin: HTTPS, or loopback HTTP for local testing. Never credentials, paths or queries. */
function libraryOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw fail('invalid_origin');
  }
  const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw fail('invalid_origin');
  }
  return url.origin;
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
function pkce() {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
    state: b64url(randomBytes(32)),
  };
}

/** Secret IDs are per vault, Library and Library account, so one device can hold several connections. */
function secretId(vaultKey, serverId, accountId) {
  return (
    'frameleaf-' +
    createHash('sha256')
      .update(`${vaultKey}\n${serverId}\n${accountId}`)
      .digest('hex')
      .slice(0, 40)
  );
}

/** Stable name for one asset revision and rendition variant; the extension follows the received bytes. */
function attachmentPrefix(asset) {
  const revision = Date.parse(asset?.updatedAt);
  if (
    !UUID.test(asset?.id ?? '') ||
    asset.type !== 'IMAGE' ||
    !Number.isFinite(revision)
  )
    throw fail('unsupported_image');
  return `frameleaf-${asset.id}-${revision.toString(36)}-${VARIANT}.`;
}

function imageExtension(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'png';
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  throw fail('unsupported_image');
}

/**
 * Alt text that is safe inside both wikilinks and Markdown links: no link, embed, heading, block,
 * emphasis or HTML syntax, one line, and never a bare size (Obsidian reads "300" or "300x200" as one).
 */
function altText(value) {
  const text = String(value ?? '')
    .replace(/[\[\]|#^\\`*_<>!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
  return /^\d+(x\d+)?$/.test(text) ? '' : text;
}

async function call(
  request,
  url,
  { method = 'GET', headers = {}, body, contentType, limit = JSON_LIMIT } = {},
) {
  let response;
  try {
    response = await request({
      url,
      method,
      headers,
      body,
      contentType,
      throw: false,
    });
  } catch {
    throw fail('connection_failed');
  }
  const status = response.status;
  if (status === 401 || status === 403) throw fail('access_denied');
  if (status === 429) throw fail('rate_limited');
  if (status >= 400 && status < 500) throw fail('rejected');
  if (status < 200 || status >= 300) throw fail('connection_failed');
  if (response.arrayBuffer.byteLength > limit) throw fail('too_large');
  return response;
}
function parse(response) {
  try {
    const value = JSON.parse(new TextDecoder().decode(response.arrayBuffer));
    if (value && typeof value === 'object') return value;
  } catch {}
  throw fail('invalid_response');
}
const form = (fields) => ({
  method: 'POST',
  body: new URLSearchParams(fields).toString(),
  contentType: 'application/x-www-form-urlencoded',
});

function checkTokens(value) {
  const ok = (token) =>
    typeof token === 'string' && token.length > 0 && token.length <= 16384;
  if (
    !ok(value.access_token) ||
    !ok(value.refresh_token) ||
    String(value.token_type).toLowerCase() !== 'bearer' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 86400 ||
    value.scope !== SCOPE
  ) {
    throw fail('invalid_response');
  }
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expires: Date.now() + value.expires_in * 1000,
  };
}

const page = (ok) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Frameleaf</title>` +
  `<p style="font:16px system-ui;margin:3em auto;max-width:32em">${ok ? t('callback_ok') : t('callback_bad')}</p>`;

/** One-shot loopback receiver on 127.0.0.1 with a random port. Expires after five minutes. */
function listenForCode(state, ttl = CALLBACK_TTL) {
  const server = http.createServer();
  const expected = Buffer.from(state);
  let settle;
  let done = false;
  const result = new Promise(
    (resolve, reject) => (settle = { resolve, reject }),
  );
  result.catch(() => {});
  const finish = (outcome, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    settle[outcome](value);
  };
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const given = Buffer.from(url.searchParams.get('state') ?? '');
    const valid =
      !done &&
      req.method === 'GET' &&
      url.pathname === '/callback' &&
      given.length === expected.length &&
      timingSafeEqual(given, expected);
    res.writeHead(valid ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(page(valid));
    if (!valid) return; // A stray or forged request never ends the wait for the real browser callback.
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error)
      finish(
        'reject',
        fail(error === 'access_denied' ? 'denied' : 'invalid_callback'),
      );
    else if (code && code.length <= 2048) finish('resolve', code);
    else finish('reject', fail('invalid_callback'));
  });
  const timer = setTimeout(() => finish('reject', fail('expired')), ttl);
  const ready = new Promise((resolve, reject) => {
    server.once('error', () => {
      finish('reject', fail('callback_unavailable'));
      reject(fail('callback_unavailable'));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}/callback`),
    );
  });
  return {
    ready,
    result,
    server,
    cancel: () => finish('reject', fail('cancelled')),
  };
}

/**
 * The connection to one Library account. Only the refresh token is persisted, in Obsidian's
 * SecretStorage; data.json (which vault sync copies) holds the non-secret identifiers.
 */
class Connection {
  constructor({
    settings,
    save,
    secrets,
    request = obsidian.requestUrl,
    openUrl,
    ttl,
  }) {
    Object.assign(this, { settings, save, secrets, request, openUrl, ttl });
    this.access = null;
    this.refreshing = null;
    this.pending = null;
  }
  key() {
    return secretId(
      this.settings.vaultKey,
      this.settings.serverId,
      this.settings.accountId,
    );
  }
  get connected() {
    return !!(this.settings.serverId && this.secrets.getSecret(this.key()));
  }

  async connect(input, clientIdInput = '') {
    const origin = libraryOrigin(input);
    if (this.connected) throw fail('disconnect_first');
    this.pending?.cancel();
    const meta = parse(
      await call(
        this.request,
        `${origin}/.well-known/oauth-authorization-server`,
      ),
    );
    const endpoints = {
      authorization_endpoint: 'authorize',
      token_endpoint: 'token',
      revocation_endpoint: 'revoke',
    };
    for (const [key, path] of Object.entries(endpoints)) {
      if (meta[key] !== `${origin}/api/oauth/apps/${path}`)
        throw fail('invalid_response');
    }
    if (
      meta.issuer !== origin ||
      !meta.code_challenge_methods_supported?.includes('S256')
    )
      throw fail('invalid_response');

    const { verifier, challenge, state } = pkce();
    const listener = listenForCode(state, this.ttl);
    this.pending = listener;
    try {
      const redirectUri = await listener.ready;
      let clientId =
        String(clientIdInput ?? '').trim() ||
        (this.settings.origin === origin ? this.settings.clientId : '');
      if (!clientId) {
        if (meta.registration_endpoint !== `${origin}/api/oauth/apps/register`)
          throw fail('client_id_required');
        const client = parse(
          await call(this.request, meta.registration_endpoint, {
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({
              client_name: 'Frameleaf for Obsidian',
              redirect_uris: ['http://127.0.0.1/callback'],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            }),
          }),
        );
        clientId = client.client_id;
      }
      if (typeof clientId !== 'string' || !clientId || clientId.length > 200)
        throw fail('client_id_required');
      const resource = `${origin}/api/connect`;
      this.openUrl(
        `${meta.authorization_endpoint}?${new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: SCOPE,
          resource,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })}`,
      );
      const code = await listener.result;
      const tokens = checkTokens(
        parse(
          await call(
            this.request,
            meta.token_endpoint,
            form({
              grant_type: 'authorization_code',
              code,
              client_id: clientId,
              redirect_uri: redirectUri,
              code_verifier: verifier,
              resource,
            }),
          ),
        ),
      );
      let caps;
      try {
        caps = parse(
          await call(this.request, `${resource}/capabilities`, {
            headers: { Authorization: `Bearer ${tokens.access}` },
          }),
        );
        if (
          caps.protocolVersion !== 1 ||
          typeof caps.server?.id !== 'string' ||
          !caps.server.id ||
          !UUID.test(caps.connection?.libraryUserId ?? '') ||
          !caps.scopes?.includes(SCOPE)
        )
          throw fail('invalid_response');
      } catch (error) {
        await this.revoke(origin, clientId, tokens.refresh).catch(() => {});
        throw error;
      }
      Object.assign(this.settings, {
        origin,
        clientId,
        serverId: caps.server.id,
        accountId: caps.connection.libraryUserId,
        serverName: String(caps.server.name ?? ''),
        accountName: String(caps.displayIdentity?.name ?? ''),
      });
      this.secrets.setSecret(this.key(), tokens.refresh);
      this.access = { token: tokens.access, expires: tokens.expires };
      await this.save();
    } finally {
      listener.cancel();
      if (this.pending === listener) this.pending = null;
    }
  }

  async token() {
    if (this.access && this.access.expires > Date.now() + 30_000)
      return this.access.token;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }
  async refresh() {
    const key = this.key();
    const refresh = this.settings.serverId && this.secrets.getSecret(key);
    if (!refresh) throw fail('reconnect');
    const { origin, clientId } = this.settings;
    let tokens;
    try {
      tokens = checkTokens(
        parse(
          await call(
            this.request,
            `${origin}/api/oauth/apps/token`,
            form({
              grant_type: 'refresh_token',
              refresh_token: refresh,
              client_id: clientId,
              resource: `${origin}/api/connect`,
            }),
          ),
        ),
      );
    } catch (error) {
      // Network trouble keeps the token for a later retry; a refused or garbled answer means it is spent.
      if (error.code === 'connection_failed' || error.code === 'rate_limited')
        throw error;
      await this.forget();
      throw fail('reconnect');
    }
    if (!this.settings.serverId || this.key() !== key) {
      // Disconnected while refreshing: the new token must not outlive the disconnect.
      await this.revoke(origin, clientId, tokens.refresh).catch(() => {});
      throw fail('reconnect');
    }
    this.secrets.setSecret(key, tokens.refresh); // Rotation is persisted before the new access token is used.
    this.access = { token: tokens.access, expires: tokens.expires };
    return tokens.access;
  }
  async api(path, limit = JSON_LIMIT) {
    const token = await this.token();
    try {
      return await call(
        this.request,
        `${this.settings.origin}/api/connect/${path}`,
        { headers: { Authorization: `Bearer ${token}` }, limit },
      );
    } catch (error) {
      if (error.code === 'access_denied') this.access = null;
      throw error;
    }
  }
  revoke(origin, clientId, token) {
    return call(
      this.request,
      `${origin}/api/oauth/apps/revoke`,
      form({ token, token_type_hint: 'refresh_token', client_id: clientId }),
    );
  }
  async forget() {
    if (this.settings.serverId) this.secrets.setSecret(this.key(), '');
    this.access = null;
    Object.assign(this.settings, {
      serverId: '',
      accountId: '',
      serverName: '',
      accountName: '',
    });
    await this.save();
  }
  /** Returns false when the Library could not be told; the local credentials are removed either way. */
  async disconnect() {
    this.pending?.cancel();
    await this.refreshing?.catch(() => {});
    const refresh =
      this.settings.serverId && this.secrets.getSecret(this.key());
    let revoked = true;
    if (refresh)
      revoked = await this.revoke(
        this.settings.origin,
        this.settings.clientId,
        refresh,
      ).then(
        () => true,
        () => false,
      );
    await this.forget();
    return revoked;
  }

  async albums() {
    return (parse(await this.api('albums')).items ?? []).filter(
      (album) => album.canRead && UUID.test(album.id ?? ''),
    );
  }
  async search(q, albumId, pageNumber) {
    const params = new URLSearchParams({
      type: 'IMAGE',
      size: '40',
      page: String(pageNumber),
    });
    if (q) params.set('q', q.slice(0, 200));
    if (albumId) params.set('albumId', albumId);
    const result = parse(await this.api(`assets?${params}`));
    return {
      items: (result.items ?? []).filter(
        (asset) => UUID.test(asset.id ?? '') && asset.type === 'IMAGE',
      ),
      total: result.total ?? 0,
    };
  }
  async thumbnail(id) {
    const response = await this.api(
      `assets/${id}/rendition?variant=thumbnail`,
      THUMBNAIL_LIMIT,
    );
    return new Blob([response.arrayBuffer], {
      type: `image/${imageExtension(response.arrayBuffer).replace('jpg', 'jpeg')}`,
    });
  }
}

/**
 * Saves the asset next to the note as a local attachment (reusing an earlier copy of the same
 * revision) and returns the text to insert. Nothing is written until the whole image has arrived.
 */
async function saveAttachment(
  app,
  connection,
  asset,
  sourcePath,
  sourceLink,
  inFlight = new Map(),
) {
  const prefix = attachmentPrefix(asset);
  // Concurrent inserts of one image share the download; each builds its own link for its own note.
  if (!inFlight.has(prefix))
    inFlight.set(
      prefix,
      saveFile(app, connection, asset, prefix, sourcePath).finally(() =>
        inFlight.delete(prefix),
      ),
    );
  const file = await inFlight.get(prefix);
  let text =
    '!' +
    app.fileManager.generateMarkdownLink(
      file,
      sourcePath,
      undefined,
      altText(asset.title || asset.description),
    );
  if (sourceLink)
    text += `\n[${altText(t('source_label'))}](<${connection.settings.origin}/photos/${asset.id}>)`;
  return { file, text };
}

async function saveFile(app, connection, asset, prefix, sourcePath) {
  const existing = () =>
    app.vault.getFiles().find((file) => file.name.startsWith(prefix));
  let file = existing();
  if (!file) {
    const response = await connection.api(
      `assets/${asset.id}/rendition?variant=${VARIANT}`,
      IMAGE_LIMIT,
    );
    const extension = imageExtension(response.arrayBuffer);
    const path = await app.fileManager.getAvailablePathForAttachment(
      prefix + extension,
      sourcePath,
    );
    try {
      file = await app.vault.createBinary(path, response.arrayBuffer);
    } catch {
      file = existing(); // Another insert of the same image may have finished first.
      if (!file) throw fail('save_failed');
    }
  }
  return file;
}

class InsertModal extends obsidian.Modal {
  constructor(plugin, choose) {
    super(plugin.app);
    Object.assign(this, {
      plugin,
      choose,
      urls: [],
      sequence: 0,
      pageNumber: 1,
      query: '',
      albumId: '',
    });
  }
  async onOpen() {
    const { contentEl } = this;
    this.setTitle?.(t('modal_title'));
    contentEl.addClass('frameleaf-images');
    const bar = contentEl.createDiv({ cls: 'frameleaf-images-bar' });
    const album = bar.createEl('select', {
      cls: 'dropdown',
      attr: { 'aria-label': t('album') },
    });
    album.createEl('option', { text: t('all_albums'), value: '' });
    const search = bar.createEl('input', {
      type: 'search',
      attr: { placeholder: t('search'), 'aria-label': t('search') },
    });
    this.status = contentEl.createDiv({
      cls: 'frameleaf-images-status',
      attr: { role: 'status' },
    });
    this.grid = contentEl.createDiv({ cls: 'frameleaf-images-grid' });
    this.more = contentEl.createEl('button', { text: t('more') });
    this.more.hide();
    this.more.onclick = () => this.load(false);
    let timer;
    search.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => ((this.query = search.value.trim()), this.load(true)),
        300,
      );
    };
    album.onchange = () => ((this.albumId = album.value), this.load(true));
    search.focus();
    try {
      for (const item of await this.plugin.connection.albums())
        album.createEl('option', { text: item.name, value: item.id });
    } catch (error) {
      this.status.setText(t(error.code));
    }
    await this.load(true);
  }
  async load(reset) {
    const sequence = ++this.sequence;
    if (reset) {
      this.pageNumber = 1;
      this.grid.empty();
      this.release();
    }
    this.status.setText(t('loading'));
    this.more.hide();
    try {
      const { items, total } = await this.plugin.connection.search(
        this.query,
        this.albumId,
        this.pageNumber,
      );
      if (sequence !== this.sequence) return;
      this.status.setText(items.length || !reset ? '' : t('empty'));
      for (const asset of items) this.tile(asset, sequence);
      if (this.pageNumber * 40 < total) this.more.show();
      this.pageNumber += 1;
    } catch (error) {
      if (sequence === this.sequence) this.status.setText(t(error.code));
    }
  }
  tile(asset, sequence) {
    const label = altText(asset.title || asset.description) || t('image');
    const button = this.grid.createEl('button', {
      cls: 'frameleaf-images-tile',
      attr: { 'aria-label': label, title: label },
    });
    button.onclick = () => {
      this.close();
      this.choose(asset);
    };
    this.plugin.connection.thumbnail(asset.id).then(
      (blob) => {
        if (sequence !== this.sequence) return;
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        button.createEl('img', { attr: { src: url, alt: '' } });
      },
      () => button.addClass('is-missing'),
    );
  }
  release() {
    for (const url of this.urls.splice(0)) URL.revokeObjectURL(url);
  }
  onClose() {
    this.sequence += 1;
    this.release();
    this.contentEl.empty();
  }
}

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl, plugin } = this;
    const { settings, connection } = plugin;
    containerEl.empty();
    const connected = connection.connected;
    new obsidian.Setting(containerEl)
      .setName(t('origin'))
      .setDesc(t('origin_desc'))
      .addText((text) =>
        text
          .setPlaceholder('https://photos.example.com')
          .setValue(settings.origin)
          .setDisabled(connected)
          .onChange((value) => (this.origin = value)),
      );
    new obsidian.Setting(containerEl)
      .setName(t('client'))
      .setDesc(t('client_desc'))
      .addText((text) =>
        text
          .setValue(settings.clientId)
          .setDisabled(connected)
          .onChange((value) => (this.clientId = value)),
      );
    new obsidian.Setting(containerEl)
      .setName(
        connected
          ? t('connected', {
              server: settings.serverName,
              account: settings.accountName,
            })
          : t('disconnected'),
      )
      .addButton((button) =>
        button
          .setButtonText(connected ? t('disconnect') : t('connect'))
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              if (connected) {
                if (!(await connection.disconnect()))
                  new obsidian.Notice(t('disconnected_local'), 10_000);
              } else {
                new obsidian.Notice(t('waiting'), 10_000);
                await connection.connect(
                  this.origin ?? settings.origin,
                  // Only an edited App ID is explicit; otherwise connect() reuses the stored one for the same Library.
                  this.clientId,
                );
              }
            } catch (error) {
              new obsidian.Notice(t(error.code));
            }
            this.origin = this.clientId = undefined;
            this.display();
          }),
      );
    new obsidian.Setting(containerEl)
      .setName(t('source_link'))
      .addToggle((toggle) =>
        toggle.setValue(settings.sourceLink).onChange(async (value) => {
          settings.sourceLink = value;
          await plugin.saveData(settings);
        }),
      );
  }
}

const DEFAULTS = {
  vaultKey: '',
  origin: '',
  clientId: '',
  serverId: '',
  accountId: '',
  serverName: '',
  accountName: '',
  sourceLink: false,
};

class FrameleafImages extends obsidian.Plugin {
  async onload() {
    const stored = (await this.loadData()) ?? {};
    this.settings = Object.fromEntries(
      Object.entries(DEFAULTS).map(([key, value]) => [
        key,
        typeof stored[key] === typeof value ? stored[key] : value,
      ]),
    );
    if (!/^[0-9a-f]{32}$/.test(this.settings.vaultKey))
      this.settings.vaultKey = randomBytes(16).toString('hex');
    this.connection = new Connection({
      settings: this.settings,
      save: () => this.saveData(this.settings),
      secrets: this.app.secretStorage,
      openUrl: (url) => window.open(url),
    });
    this.inFlight = new Map();
    this.addCommand({
      id: 'insert-image',
      name: t('command'),
      editorCallback: (editor, view) => {
        if (!this.connection.connected)
          return new obsidian.Notice(t('reconnect'));
        const file = view.file;
        new InsertModal(this, (asset) =>
          this.insert(editor, file, asset),
        ).open();
      },
    });
    this.addSettingTab(new SettingsTab(this));
  }
  onunload() {
    this.connection?.pending?.cancel();
  }
  async insert(editor, file, asset) {
    try {
      const saved = await saveAttachment(
        this.app,
        this.connection,
        asset,
        file.path,
        this.settings.sourceLink,
        this.inFlight,
      );
      // The download may outlast the note; only insert into the editor that asked, while it still shows that note.
      const view = this.app.workspace.getActiveViewOfType(
        obsidian.MarkdownView,
      );
      if (view?.file !== file || view.editor !== editor)
        return new obsidian.Notice(
          t('inserted_elsewhere', { path: saved.file.path }),
        );
      editor.replaceSelection(saved.text);
    } catch (error) {
      new obsidian.Notice(t(error.code));
    }
  }
}

const MESSAGES = {
  en: {
    command: 'Insert image from Frameleaf',
    modal_title: 'Insert image from Frameleaf',
    album: 'Album',
    all_albums: 'All authorized albums',
    search: 'Search',
    more: 'Load more',
    empty: 'No images found.',
    loading: 'Loading…',
    image: 'Image',
    origin: 'Library address',
    origin_desc:
      "Your Frameleaf Library's HTTPS address, for example https://photos.example.com.",
    client: 'App ID (optional)',
    client_desc:
      'Only needed when your Library administrator registered this plugin for you.',
    connect: 'Connect',
    disconnect: 'Disconnect',
    connected: 'Connected to {server} as {account}.',
    disconnected: 'Not connected.',
    waiting:
      'Finish signing in to Frameleaf in your browser. The request expires in 5 minutes.',
    source_link: 'Add a link to the photo in Frameleaf',
    source_label: 'View in Frameleaf',
    inserted_elsewhere:
      'Saved {path}. The note changed, so no link was inserted.',
    disconnected_local:
      'Disconnected on this device. The Library could not be reached, so also remove Frameleaf for Obsidian from your connected apps in Frameleaf.',
    callback_ok: 'Signed in. You can close this tab and return to Obsidian.',
    callback_bad:
      'This sign-in link is not valid. Return to Obsidian and try again.',
    invalid_origin: "Enter the Library's HTTPS address, without a path.",
    connection_failed: 'Frameleaf could not be reached. Try again.',
    access_denied:
      'Frameleaf refused access. Connect again or check the albums you allowed.',
    rate_limited: 'Frameleaf is busy. Try again in a minute.',
    rejected: 'Frameleaf could not complete the request.',
    too_large: 'The image is too large to insert.',
    invalid_response:
      'Frameleaf sent an unexpected answer. Check that the Library is up to date.',
    client_id_required: 'This Library needs an App ID from its administrator.',
    denied: 'Sign-in was cancelled in Frameleaf.',
    expired: 'Sign-in took longer than 5 minutes. Try again.',
    cancelled: 'Sign-in was cancelled.',
    callback_unavailable: 'Obsidian could not receive the sign-in. Try again.',
    invalid_callback: 'The sign-in answer was not valid. Try again.',
    reconnect: "Connect to Frameleaf in this plugin's settings.",
    disconnect_first: 'Disconnect first.',
    unsupported_image: "This image type can't be inserted.",
    save_failed:
      'The image could not be saved to this vault. Check that the vault folder is writable.',
  },
  da: {
    command: 'Indsæt billede fra Frameleaf',
    modal_title: 'Indsæt billede fra Frameleaf',
    album: 'Album',
    all_albums: 'Alle godkendte albummer',
    search: 'Søg',
    more: 'Indlæs flere',
    empty: 'Ingen billeder fundet.',
    loading: 'Indlæser…',
    image: 'Billede',
    origin: 'Biblioteksadresse',
    origin_desc:
      'Dit Frameleaf-biblioteks HTTPS-adresse, for eksempel https://photos.example.com.',
    client: 'App-id (valgfrit)',
    client_desc:
      'Kun nødvendigt, når din biblioteksadministrator har registreret dette plugin for dig.',
    connect: 'Forbind',
    disconnect: 'Afbryd forbindelse',
    connected: 'Forbundet til {server} som {account}.',
    disconnected: 'Ikke forbundet.',
    waiting:
      'Afslut login til Frameleaf i din browser. Anmodningen udløber om 5 minutter.',
    source_link: 'Tilføj et link til billedet i Frameleaf',
    source_label: 'Vis i Frameleaf',
    inserted_elsewhere:
      '{path} er gemt. Noten er ændret, så der blev ikke indsat et link.',
    disconnected_local:
      'Forbindelsen er afbrudt på denne enhed. Biblioteket kunne ikke nås, så fjern også Frameleaf for Obsidian fra dine forbundne apps i Frameleaf.',
    callback_ok:
      'Du er logget ind. Du kan lukke denne fane og vende tilbage til Obsidian.',
    callback_bad:
      'Dette loginlink er ikke gyldigt. Gå tilbage til Obsidian, og prøv igen.',
    invalid_origin: 'Angiv bibliotekets HTTPS-adresse uden sti.',
    connection_failed: 'Frameleaf kunne ikke nås. Prøv igen.',
    access_denied:
      'Frameleaf afviste adgang. Forbind igen, eller kontrollér de albummer, du har tilladt.',
    rate_limited: 'Frameleaf har travlt. Prøv igen om et minut.',
    rejected: 'Frameleaf kunne ikke gennemføre anmodningen.',
    too_large: 'Billedet er for stort til at blive indsat.',
    invalid_response:
      'Frameleaf sendte et uventet svar. Kontrollér, at biblioteket er opdateret.',
    client_id_required: 'Dette bibliotek kræver et app-id fra administratoren.',
    denied: 'Login blev annulleret i Frameleaf.',
    expired: 'Login tog mere end 5 minutter. Prøv igen.',
    cancelled: 'Login blev annulleret.',
    callback_unavailable: 'Obsidian kunne ikke modtage login. Prøv igen.',
    invalid_callback: 'Svaret fra login var ikke gyldigt. Prøv igen.',
    reconnect: 'Forbind til Frameleaf i dette plugins indstillinger.',
    disconnect_first: 'Afbryd forbindelsen først.',
    unsupported_image: 'Denne billedtype kan ikke indsættes.',
    save_failed:
      'Billedet kunne ikke gemmes i denne boks. Kontrollér, at boksens mappe er skrivbar.',
  },
  de: {
    command: 'Bild aus Frameleaf einfügen',
    modal_title: 'Bild aus Frameleaf einfügen',
    album: 'Album',
    all_albums: 'Alle freigegebenen Alben',
    search: 'Suchen',
    more: 'Mehr laden',
    empty: 'Keine Bilder gefunden.',
    loading: 'Wird geladen…',
    image: 'Bild',
    origin: 'Bibliotheksadresse',
    origin_desc:
      'Die HTTPS-Adresse deiner Frameleaf-Bibliothek, zum Beispiel https://photos.example.com.',
    client: 'App-ID (optional)',
    client_desc:
      'Nur nötig, wenn deine Bibliotheksverwaltung dieses Plugin für dich registriert hat.',
    connect: 'Verbinden',
    disconnect: 'Trennen',
    connected: 'Mit {server} als {account} verbunden.',
    disconnected: 'Nicht verbunden.',
    waiting:
      'Schließe die Anmeldung bei Frameleaf im Browser ab. Die Anfrage läuft in 5 Minuten ab.',
    source_link: 'Link zum Foto in Frameleaf hinzufügen',
    source_label: 'In Frameleaf ansehen',
    inserted_elsewhere:
      '{path} gespeichert. Die Notiz hat sich geändert, daher wurde kein Link eingefügt.',
    disconnected_local:
      'Auf diesem Gerät getrennt. Die Bibliothek war nicht erreichbar, entferne Frameleaf für Obsidian deshalb auch aus deinen verbundenen Apps in Frameleaf.',
    callback_ok:
      'Angemeldet. Du kannst diesen Tab schließen und zu Obsidian zurückkehren.',
    callback_bad:
      'Dieser Anmeldelink ist ungültig. Kehre zu Obsidian zurück und versuche es erneut.',
    invalid_origin: 'Gib die HTTPS-Adresse der Bibliothek ohne Pfad ein.',
    connection_failed: 'Frameleaf ist nicht erreichbar. Versuche es erneut.',
    access_denied:
      'Frameleaf hat den Zugriff verweigert. Verbinde dich erneut oder prüfe die freigegebenen Alben.',
    rate_limited:
      'Frameleaf ist ausgelastet. Versuche es in einer Minute erneut.',
    rejected: 'Frameleaf konnte die Anfrage nicht abschließen.',
    too_large: 'Das Bild ist zu groß zum Einfügen.',
    invalid_response:
      'Frameleaf hat unerwartet geantwortet. Prüfe, ob die Bibliothek aktuell ist.',
    client_id_required:
      'Diese Bibliothek benötigt eine App-ID von der Verwaltung.',
    denied: 'Die Anmeldung wurde in Frameleaf abgebrochen.',
    expired:
      'Die Anmeldung hat länger als 5 Minuten gedauert. Versuche es erneut.',
    cancelled: 'Die Anmeldung wurde abgebrochen.',
    callback_unavailable:
      'Obsidian konnte die Anmeldung nicht empfangen. Versuche es erneut.',
    invalid_callback: 'Die Anmeldeantwort war ungültig. Versuche es erneut.',
    reconnect:
      'Verbinde dich in den Einstellungen dieses Plugins mit Frameleaf.',
    disconnect_first: 'Trenne zuerst die Verbindung.',
    unsupported_image: 'Dieser Bildtyp kann nicht eingefügt werden.',
    save_failed:
      'Das Bild konnte nicht im Tresor gespeichert werden. Prüfe, ob der Tresorordner beschreibbar ist.',
  },
  es: {
    command: 'Insertar imagen de Frameleaf',
    modal_title: 'Insertar imagen de Frameleaf',
    album: 'Álbum',
    all_albums: 'Todos los álbumes autorizados',
    search: 'Buscar',
    more: 'Cargar más',
    empty: 'No se encontraron imágenes.',
    loading: 'Cargando…',
    image: 'Imagen',
    origin: 'Dirección de la biblioteca',
    origin_desc:
      'La dirección HTTPS de tu biblioteca Frameleaf, por ejemplo https://photos.example.com.',
    client: 'ID de la app (opcional)',
    client_desc:
      'Solo es necesario si el administrador de tu biblioteca registró este plugin para ti.',
    connect: 'Conectar',
    disconnect: 'Desconectar',
    connected: 'Conectado a {server} como {account}.',
    disconnected: 'Sin conexión.',
    waiting:
      'Termina de iniciar sesión en Frameleaf en tu navegador. La solicitud caduca en 5 minutos.',
    source_link: 'Añadir un enlace a la foto en Frameleaf',
    source_label: 'Ver en Frameleaf',
    inserted_elsewhere:
      'Se guardó {path}. La nota cambió, así que no se insertó ningún enlace.',
    disconnected_local:
      'Desconectado en este dispositivo. No se pudo contactar con la biblioteca, así que quita también Frameleaf para Obsidian de tus apps conectadas en Frameleaf.',
    callback_ok:
      'Sesión iniciada. Puedes cerrar esta pestaña y volver a Obsidian.',
    callback_bad:
      'Este enlace de inicio de sesión no es válido. Vuelve a Obsidian e inténtalo de nuevo.',
    invalid_origin: 'Introduce la dirección HTTPS de la biblioteca, sin ruta.',
    connection_failed:
      'No se pudo contactar con Frameleaf. Inténtalo de nuevo.',
    access_denied:
      'Frameleaf denegó el acceso. Vuelve a conectar o revisa los álbumes que permitiste.',
    rate_limited: 'Frameleaf está ocupado. Inténtalo dentro de un minuto.',
    rejected: 'Frameleaf no pudo completar la solicitud.',
    too_large: 'La imagen es demasiado grande para insertarla.',
    invalid_response:
      'Frameleaf envió una respuesta inesperada. Comprueba que la biblioteca esté actualizada.',
    client_id_required:
      'Esta biblioteca necesita un ID de app de su administrador.',
    denied: 'Se canceló el inicio de sesión en Frameleaf.',
    expired: 'El inicio de sesión tardó más de 5 minutos. Inténtalo de nuevo.',
    cancelled: 'Se canceló el inicio de sesión.',
    callback_unavailable:
      'Obsidian no pudo recibir el inicio de sesión. Inténtalo de nuevo.',
    invalid_callback:
      'La respuesta del inicio de sesión no era válida. Inténtalo de nuevo.',
    reconnect: 'Conéctate a Frameleaf en los ajustes de este plugin.',
    disconnect_first: 'Desconecta primero.',
    unsupported_image: 'Este tipo de imagen no se puede insertar.',
    save_failed:
      'No se pudo guardar la imagen en esta bóveda. Comprueba que la carpeta de la bóveda admite escritura.',
  },
  fr: {
    command: 'Insérer une image depuis Frameleaf',
    modal_title: 'Insérer une image depuis Frameleaf',
    album: 'Album',
    all_albums: 'Tous les albums autorisés',
    search: 'Rechercher',
    more: 'Charger plus',
    empty: 'Aucune image trouvée.',
    loading: 'Chargement…',
    image: 'Image',
    origin: 'Adresse de la bibliothèque',
    origin_desc:
      "L'adresse HTTPS de votre bibliothèque Frameleaf, par exemple https://photos.example.com.",
    client: "ID d'application (facultatif)",
    client_desc:
      "Nécessaire uniquement si l'administrateur de votre bibliothèque a enregistré ce plugin pour vous.",
    connect: 'Connecter',
    disconnect: 'Déconnecter',
    connected: 'Connecté à {server} en tant que {account}.',
    disconnected: 'Non connecté.',
    waiting:
      'Terminez la connexion à Frameleaf dans votre navigateur. La demande expire dans 5 minutes.',
    source_link: 'Ajouter un lien vers la photo dans Frameleaf',
    source_label: 'Voir dans Frameleaf',
    inserted_elsewhere:
      "{path} enregistré. La note a changé, aucun lien n'a donc été inséré.",
    disconnected_local:
      'Déconnecté sur cet appareil. La bibliothèque était injoignable : retirez aussi Frameleaf pour Obsidian de vos applications connectées dans Frameleaf.',
    callback_ok:
      'Connexion réussie. Vous pouvez fermer cet onglet et revenir à Obsidian.',
    callback_bad:
      "Ce lien de connexion n'est pas valide. Revenez à Obsidian et réessayez.",
    invalid_origin:
      "Saisissez l'adresse HTTPS de la bibliothèque, sans chemin.",
    connection_failed: 'Frameleaf est injoignable. Réessayez.',
    access_denied:
      "Frameleaf a refusé l'accès. Reconnectez-vous ou vérifiez les albums autorisés.",
    rate_limited: 'Frameleaf est occupé. Réessayez dans une minute.',
    rejected: "Frameleaf n'a pas pu terminer la demande.",
    too_large: "L'image est trop volumineuse pour être insérée.",
    invalid_response:
      'Frameleaf a renvoyé une réponse inattendue. Vérifiez que la bibliothèque est à jour.',
    client_id_required:
      "Cette bibliothèque requiert un ID d'application fourni par son administrateur.",
    denied: 'La connexion a été annulée dans Frameleaf.',
    expired: 'La connexion a pris plus de 5 minutes. Réessayez.',
    cancelled: 'La connexion a été annulée.',
    callback_unavailable:
      "Obsidian n'a pas pu recevoir la connexion. Réessayez.",
    invalid_callback: "La réponse de connexion n'est pas valide. Réessayez.",
    reconnect: 'Connectez-vous à Frameleaf dans les réglages de ce plugin.',
    disconnect_first: "Déconnectez-vous d'abord.",
    unsupported_image: "Ce type d'image ne peut pas être inséré.",
    save_failed:
      "L'image n'a pas pu être enregistrée dans ce coffre. Vérifiez que le dossier du coffre est accessible en écriture.",
  },
  it: {
    command: 'Inserisci immagine da Frameleaf',
    modal_title: 'Inserisci immagine da Frameleaf',
    album: 'Album',
    all_albums: 'Tutti gli album autorizzati',
    search: 'Cerca',
    more: 'Carica altro',
    empty: 'Nessuna immagine trovata.',
    loading: 'Caricamento…',
    image: 'Immagine',
    origin: 'Indirizzo della libreria',
    origin_desc:
      "L'indirizzo HTTPS della tua libreria Frameleaf, ad esempio https://photos.example.com.",
    client: 'ID app (facoltativo)',
    client_desc:
      "Serve solo se l'amministratore della libreria ha registrato questo plugin per te.",
    connect: 'Connetti',
    disconnect: 'Disconnetti',
    connected: 'Connesso a {server} come {account}.',
    disconnected: 'Non connesso.',
    waiting:
      "Completa l'accesso a Frameleaf nel browser. La richiesta scade tra 5 minuti.",
    source_link: 'Aggiungi un link alla foto in Frameleaf',
    source_label: 'Apri in Frameleaf',
    inserted_elsewhere:
      '{path} salvato. La nota è cambiata, quindi non è stato inserito alcun link.',
    disconnected_local:
      'Disconnesso su questo dispositivo. La libreria non era raggiungibile: rimuovi anche Frameleaf per Obsidian dalle app connesse in Frameleaf.',
    callback_ok:
      'Accesso eseguito. Puoi chiudere questa scheda e tornare a Obsidian.',
    callback_bad:
      'Questo link di accesso non è valido. Torna a Obsidian e riprova.',
    invalid_origin:
      "Inserisci l'indirizzo HTTPS della libreria, senza percorso.",
    connection_failed: 'Impossibile raggiungere Frameleaf. Riprova.',
    access_denied:
      "Frameleaf ha negato l'accesso. Connettiti di nuovo o controlla gli album consentiti.",
    rate_limited: 'Frameleaf è occupato. Riprova tra un minuto.',
    rejected: 'Frameleaf non ha potuto completare la richiesta.',
    too_large: "L'immagine è troppo grande per essere inserita.",
    invalid_response:
      'Frameleaf ha inviato una risposta inattesa. Verifica che la libreria sia aggiornata.',
    client_id_required:
      'Questa libreria richiede un ID app dal suo amministratore.',
    denied: "L'accesso è stato annullato in Frameleaf.",
    expired: "L'accesso ha richiesto più di 5 minuti. Riprova.",
    cancelled: "L'accesso è stato annullato.",
    callback_unavailable: "Obsidian non ha potuto ricevere l'accesso. Riprova.",
    invalid_callback: 'La risposta di accesso non era valida. Riprova.',
    reconnect: 'Connettiti a Frameleaf nelle impostazioni di questo plugin.',
    disconnect_first: 'Prima disconnettiti.',
    unsupported_image: 'Questo tipo di immagine non può essere inserito.',
    save_failed:
      "Impossibile salvare l'immagine in questo vault. Verifica che la cartella del vault sia scrivibile.",
  },
  nb: {
    command: 'Sett inn bilde fra Frameleaf',
    modal_title: 'Sett inn bilde fra Frameleaf',
    album: 'Album',
    all_albums: 'Alle godkjente album',
    search: 'Søk',
    more: 'Last inn flere',
    empty: 'Fant ingen bilder.',
    loading: 'Laster inn…',
    image: 'Bilde',
    origin: 'Bibliotekadresse',
    origin_desc:
      'HTTPS-adressen til Frameleaf-biblioteket ditt, for eksempel https://photos.example.com.',
    client: 'App-ID (valgfritt)',
    client_desc:
      'Trengs bare når bibliotekadministratoren har registrert denne utvidelsen for deg.',
    connect: 'Koble til',
    disconnect: 'Koble fra',
    connected: 'Koblet til {server} som {account}.',
    disconnected: 'Ikke tilkoblet.',
    waiting:
      'Fullfør påloggingen til Frameleaf i nettleseren. Forespørselen utløper om 5 minutter.',
    source_link: 'Legg til en lenke til bildet i Frameleaf',
    source_label: 'Vis i Frameleaf',
    inserted_elsewhere:
      '{path} er lagret. Notatet er endret, så ingen lenke ble satt inn.',
    disconnected_local:
      'Koblet fra på denne enheten. Biblioteket kunne ikke nås, så fjern også Frameleaf for Obsidian fra de tilkoblede appene dine i Frameleaf.',
    callback_ok:
      'Du er logget på. Du kan lukke denne fanen og gå tilbake til Obsidian.',
    callback_bad:
      'Denne påloggingslenken er ikke gyldig. Gå tilbake til Obsidian og prøv igjen.',
    invalid_origin: 'Skriv inn HTTPS-adressen til biblioteket, uten sti.',
    connection_failed: 'Frameleaf kunne ikke nås. Prøv igjen.',
    access_denied:
      'Frameleaf nektet tilgang. Koble til på nytt eller sjekk albumene du har tillatt.',
    rate_limited: 'Frameleaf er opptatt. Prøv igjen om et minutt.',
    rejected: 'Frameleaf kunne ikke fullføre forespørselen.',
    too_large: 'Bildet er for stort til å settes inn.',
    invalid_response:
      'Frameleaf sendte et uventet svar. Sjekk at biblioteket er oppdatert.',
    client_id_required:
      'Dette biblioteket trenger en app-ID fra administratoren.',
    denied: 'Påloggingen ble avbrutt i Frameleaf.',
    expired: 'Påloggingen tok mer enn 5 minutter. Prøv igjen.',
    cancelled: 'Påloggingen ble avbrutt.',
    callback_unavailable: 'Obsidian kunne ikke motta påloggingen. Prøv igjen.',
    invalid_callback: 'Påloggingssvaret var ikke gyldig. Prøv igjen.',
    reconnect: 'Koble til Frameleaf i innstillingene for denne utvidelsen.',
    disconnect_first: 'Koble fra først.',
    unsupported_image: 'Denne bildetypen kan ikke settes inn.',
    save_failed:
      'Bildet kunne ikke lagres i dette hvelvet. Sjekk at hvelvmappen er skrivbar.',
  },
  nl: {
    command: 'Afbeelding uit Frameleaf invoegen',
    modal_title: 'Afbeelding uit Frameleaf invoegen',
    album: 'Album',
    all_albums: 'Alle toegestane albums',
    search: 'Zoeken',
    more: 'Meer laden',
    empty: 'Geen afbeeldingen gevonden.',
    loading: 'Laden…',
    image: 'Afbeelding',
    origin: 'Bibliotheekadres',
    origin_desc:
      'Het HTTPS-adres van je Frameleaf-bibliotheek, bijvoorbeeld https://photos.example.com.',
    client: 'App-ID (optioneel)',
    client_desc:
      'Alleen nodig als de beheerder van je bibliotheek deze plug-in voor je heeft geregistreerd.',
    connect: 'Verbinden',
    disconnect: 'Verbinding verbreken',
    connected: 'Verbonden met {server} als {account}.',
    disconnected: 'Niet verbonden.',
    waiting:
      'Rond het inloggen bij Frameleaf af in je browser. Het verzoek verloopt over 5 minuten.',
    source_link: 'Een link naar de foto in Frameleaf toevoegen',
    source_label: 'Bekijken in Frameleaf',
    inserted_elsewhere:
      '{path} opgeslagen. De notitie is gewijzigd, dus er is geen link ingevoegd.',
    disconnected_local:
      'Verbinding verbroken op dit apparaat. De bibliotheek was niet bereikbaar, dus verwijder Frameleaf voor Obsidian ook uit je verbonden apps in Frameleaf.',
    callback_ok:
      'Ingelogd. Je kunt dit tabblad sluiten en teruggaan naar Obsidian.',
    callback_bad:
      'Deze inloglink is niet geldig. Ga terug naar Obsidian en probeer het opnieuw.',
    invalid_origin: 'Voer het HTTPS-adres van de bibliotheek in, zonder pad.',
    connection_failed: 'Frameleaf is niet bereikbaar. Probeer het opnieuw.',
    access_denied:
      'Frameleaf heeft de toegang geweigerd. Maak opnieuw verbinding of controleer de toegestane albums.',
    rate_limited: 'Frameleaf is bezet. Probeer het over een minuut opnieuw.',
    rejected: 'Frameleaf kon het verzoek niet voltooien.',
    too_large: 'De afbeelding is te groot om in te voegen.',
    invalid_response:
      'Frameleaf gaf een onverwacht antwoord. Controleer of de bibliotheek is bijgewerkt.',
    client_id_required:
      'Deze bibliotheek heeft een app-ID van de beheerder nodig.',
    denied: 'Het inloggen is geannuleerd in Frameleaf.',
    expired: 'Het inloggen duurde langer dan 5 minuten. Probeer het opnieuw.',
    cancelled: 'Het inloggen is geannuleerd.',
    callback_unavailable:
      'Obsidian kon de inlog niet ontvangen. Probeer het opnieuw.',
    invalid_callback: 'Het inlogantwoord was niet geldig. Probeer het opnieuw.',
    reconnect:
      'Maak verbinding met Frameleaf in de instellingen van deze plug-in.',
    disconnect_first: 'Verbreek eerst de verbinding.',
    unsupported_image: 'Dit afbeeldingstype kan niet worden ingevoegd.',
    save_failed:
      'De afbeelding kon niet in deze kluis worden opgeslagen. Controleer of de kluismap beschrijfbaar is.',
  },
  pl: {
    command: 'Wstaw obraz z Frameleaf',
    modal_title: 'Wstaw obraz z Frameleaf',
    album: 'Album',
    all_albums: 'Wszystkie autoryzowane albumy',
    search: 'Szukaj',
    more: 'Wczytaj więcej',
    empty: 'Nie znaleziono obrazów.',
    loading: 'Wczytywanie…',
    image: 'Obraz',
    origin: 'Adres biblioteki',
    origin_desc:
      'Adres HTTPS Twojej biblioteki Frameleaf, na przykład https://photos.example.com.',
    client: 'Identyfikator aplikacji (opcjonalnie)',
    client_desc:
      'Potrzebny tylko wtedy, gdy administrator biblioteki zarejestrował dla Ciebie tę wtyczkę.',
    connect: 'Połącz',
    disconnect: 'Rozłącz',
    connected: 'Połączono z {server} jako {account}.',
    disconnected: 'Brak połączenia.',
    waiting:
      'Dokończ logowanie do Frameleaf w przeglądarce. Żądanie wygaśnie za 5 minut.',
    source_link: 'Dodaj link do zdjęcia we Frameleaf',
    source_label: 'Zobacz we Frameleaf',
    inserted_elsewhere:
      'Zapisano {path}. Notatka się zmieniła, więc nie wstawiono linku.',
    disconnected_local:
      'Rozłączono na tym urządzeniu. Nie udało się połączyć z biblioteką, więc usuń też Frameleaf dla Obsidian z połączonych aplikacji we Frameleaf.',
    callback_ok: 'Zalogowano. Możesz zamknąć tę kartę i wrócić do Obsidian.',
    callback_bad:
      'Ten link logowania jest nieprawidłowy. Wróć do Obsidian i spróbuj ponownie.',
    invalid_origin: 'Wpisz adres HTTPS biblioteki bez ścieżki.',
    connection_failed: 'Nie można połączyć się z Frameleaf. Spróbuj ponownie.',
    access_denied:
      'Frameleaf odmówił dostępu. Połącz się ponownie lub sprawdź dozwolone albumy.',
    rate_limited: 'Frameleaf jest zajęty. Spróbuj ponownie za minutę.',
    rejected: 'Frameleaf nie mógł ukończyć żądania.',
    too_large: 'Obraz jest zbyt duży, aby go wstawić.',
    invalid_response:
      'Frameleaf zwrócił nieoczekiwaną odpowiedź. Sprawdź, czy biblioteka jest aktualna.',
    client_id_required:
      'Ta biblioteka wymaga identyfikatora aplikacji od administratora.',
    denied: 'Logowanie zostało anulowane we Frameleaf.',
    expired: 'Logowanie trwało dłużej niż 5 minut. Spróbuj ponownie.',
    cancelled: 'Logowanie zostało anulowane.',
    callback_unavailable:
      'Obsidian nie mógł odebrać logowania. Spróbuj ponownie.',
    invalid_callback:
      'Odpowiedź logowania była nieprawidłowa. Spróbuj ponownie.',
    reconnect: 'Połącz się z Frameleaf w ustawieniach tej wtyczki.',
    disconnect_first: 'Najpierw się rozłącz.',
    unsupported_image: 'Tego typu obrazu nie można wstawić.',
    save_failed:
      'Nie udało się zapisać obrazu w tym sejfie. Sprawdź, czy folder sejfu jest zapisywalny.',
  },
  pt: {
    command: 'Inserir imagem do Frameleaf',
    modal_title: 'Inserir imagem do Frameleaf',
    album: 'Álbum',
    all_albums: 'Todos os álbuns autorizados',
    search: 'Pesquisar',
    more: 'Carregar mais',
    empty: 'Nenhuma imagem encontrada.',
    loading: 'A carregar…',
    image: 'Imagem',
    origin: 'Endereço da biblioteca',
    origin_desc:
      'O endereço HTTPS da sua biblioteca Frameleaf, por exemplo https://photos.example.com.',
    client: 'ID da app (opcional)',
    client_desc:
      'Só é necessário se o administrador da biblioteca tiver registado este plugin para si.',
    connect: 'Ligar',
    disconnect: 'Desligar',
    connected: 'Ligado a {server} como {account}.',
    disconnected: 'Sem ligação.',
    waiting:
      'Conclua o início de sessão no Frameleaf no navegador. O pedido expira em 5 minutos.',
    source_link: 'Adicionar uma ligação para a fotografia no Frameleaf',
    source_label: 'Ver no Frameleaf',
    inserted_elsewhere:
      '{path} guardado. A nota mudou, por isso não foi inserida nenhuma ligação.',
    disconnected_local:
      'Desligado neste dispositivo. Não foi possível contactar a biblioteca, por isso remova também o Frameleaf para Obsidian das suas apps ligadas no Frameleaf.',
    callback_ok:
      'Sessão iniciada. Pode fechar este separador e voltar ao Obsidian.',
    callback_bad:
      'Esta ligação de início de sessão não é válida. Volte ao Obsidian e tente novamente.',
    invalid_origin: 'Introduza o endereço HTTPS da biblioteca, sem caminho.',
    connection_failed:
      'Não foi possível contactar o Frameleaf. Tente novamente.',
    access_denied:
      'O Frameleaf recusou o acesso. Ligue novamente ou verifique os álbuns que permitiu.',
    rate_limited:
      'O Frameleaf está ocupado. Tente novamente dentro de um minuto.',
    rejected: 'O Frameleaf não conseguiu concluir o pedido.',
    too_large: 'A imagem é demasiado grande para ser inserida.',
    invalid_response:
      'O Frameleaf enviou uma resposta inesperada. Verifique se a biblioteca está atualizada.',
    client_id_required:
      'Esta biblioteca precisa de um ID da app do administrador.',
    denied: 'O início de sessão foi cancelado no Frameleaf.',
    expired: 'O início de sessão demorou mais de 5 minutos. Tente novamente.',
    cancelled: 'O início de sessão foi cancelado.',
    callback_unavailable:
      'O Obsidian não conseguiu receber o início de sessão. Tente novamente.',
    invalid_callback:
      'A resposta de início de sessão não era válida. Tente novamente.',
    reconnect: 'Ligue-se ao Frameleaf nas definições deste plugin.',
    disconnect_first: 'Desligue primeiro.',
    unsupported_image: 'Este tipo de imagem não pode ser inserido.',
    save_failed:
      'Não foi possível guardar a imagem neste cofre. Verifique se a pasta do cofre permite escrita.',
  },
  sv: {
    command: 'Infoga bild från Frameleaf',
    modal_title: 'Infoga bild från Frameleaf',
    album: 'Album',
    all_albums: 'Alla godkända album',
    search: 'Sök',
    more: 'Läs in fler',
    empty: 'Inga bilder hittades.',
    loading: 'Läser in…',
    image: 'Bild',
    origin: 'Biblioteksadress',
    origin_desc:
      'HTTPS-adressen till ditt Frameleaf-bibliotek, till exempel https://photos.example.com.',
    client: 'App-ID (valfritt)',
    client_desc:
      'Behövs bara om biblioteksadministratören har registrerat det här tillägget åt dig.',
    connect: 'Anslut',
    disconnect: 'Koppla från',
    connected: 'Ansluten till {server} som {account}.',
    disconnected: 'Inte ansluten.',
    waiting:
      'Slutför inloggningen till Frameleaf i webbläsaren. Begäran upphör om 5 minuter.',
    source_link: 'Lägg till en länk till fotot i Frameleaf',
    source_label: 'Visa i Frameleaf',
    inserted_elsewhere:
      '{path} sparades. Anteckningen ändrades, så ingen länk infogades.',
    disconnected_local:
      'Frånkopplad på den här enheten. Biblioteket kunde inte nås, så ta även bort Frameleaf för Obsidian från dina anslutna appar i Frameleaf.',
    callback_ok:
      'Inloggad. Du kan stänga den här fliken och gå tillbaka till Obsidian.',
    callback_bad:
      'Den här inloggningslänken är inte giltig. Gå tillbaka till Obsidian och försök igen.',
    invalid_origin: 'Ange bibliotekets HTTPS-adress utan sökväg.',
    connection_failed: 'Frameleaf kunde inte nås. Försök igen.',
    access_denied:
      'Frameleaf nekade åtkomst. Anslut igen eller kontrollera de album du har tillåtit.',
    rate_limited: 'Frameleaf är upptaget. Försök igen om en minut.',
    rejected: 'Frameleaf kunde inte slutföra begäran.',
    too_large: 'Bilden är för stor för att infogas.',
    invalid_response:
      'Frameleaf skickade ett oväntat svar. Kontrollera att biblioteket är uppdaterat.',
    client_id_required:
      'Det här biblioteket behöver ett app-ID från administratören.',
    denied: 'Inloggningen avbröts i Frameleaf.',
    expired: 'Inloggningen tog mer än 5 minuter. Försök igen.',
    cancelled: 'Inloggningen avbröts.',
    callback_unavailable:
      'Obsidian kunde inte ta emot inloggningen. Försök igen.',
    invalid_callback: 'Inloggningssvaret var inte giltigt. Försök igen.',
    reconnect: 'Anslut till Frameleaf i inställningarna för det här tillägget.',
    disconnect_first: 'Koppla från först.',
    unsupported_image: 'Den här bildtypen kan inte infogas.',
    save_failed:
      'Bilden kunde inte sparas i det här valvet. Kontrollera att valvmappen är skrivbar.',
  },
};

module.exports = FrameleafImages;
module.exports.default = FrameleafImages;
module.exports.internals = {
  libraryOrigin,
  pkce,
  secretId,
  attachmentPrefix,
  imageExtension,
  altText,
  listenForCode,
  Connection,
  saveAttachment,
  MESSAGES,
  t,
};
