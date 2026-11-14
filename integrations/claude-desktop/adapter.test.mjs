import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { localeMessages, message, messages } from './messages.mjs';
import { LibraryOAuth, libraryResource } from './oauth.mjs';

const resource = new URL('https://library.example/api/mcp/assistant');
const prefix = 'https://library.example/api/oauth/apps';

test('accepts an HTTPS Library address and rejects alternate endpoints and credentials', () => {
  assert.equal(libraryResource('https://library.example:8443').href, 'https://library.example:8443/api/mcp/assistant');
  assert.equal(libraryResource(resource.href).href, resource.href);
  for (const address of [
    'http://library.example',
    'https://account:secret@library.example',
    'https://library.example/api/mcp',
    'https://library.example/?secret',
    'https://library.example/#secret',
  ]) {
    assert.throws(() => libraryResource(address), { message: message('invalidAddress') });
  }
});

test('authorizes with S256, isolates the callback and serializes rotating refresh tokens', async () => {
  const grant = {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'library:read',
  };
  let saved;
  let challenge;
  let redirectUri;
  let refreshes = 0;
  let registrations = 0;
  let revocation = false;
  const fakeFetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    switch (String(url)) {
      case 'https://library.example/.well-known/oauth-protected-resource/api/mcp/assistant':
        return Response.json({
          resource: resource.href,
          authorization_servers: [resource.origin],
          scopes_supported: ['library:read'],
        });
      case 'https://library.example/.well-known/oauth-authorization-server':
        return Response.json({
          issuer: resource.origin,
          authorization_endpoint: prefix + '/authorize',
          token_endpoint: prefix + '/token',
          registration_endpoint: prefix + '/register',
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
        });
      case prefix + '/register': {
        registrations++;
        const registration = JSON.parse(options.body);
        assert.equal(registration.token_endpoint_auth_method, 'none');
        assert.equal(registration.scope, 'library:read');
        assert.deepEqual(registration.redirect_uris, ['http://127.0.0.1/assistant/callback']);
        return Response.json({ client_id: `client-${registrations}` });
      }
      case prefix + '/token': {
        assert.equal(options.body.get('client_id'), `client-${registrations}`);
        assert.equal(options.body.get('resource'), resource.href);
        if (options.body.get('grant_type') === 'authorization_code') {
          assert.equal(options.body.get('redirect_uri'), redirectUri);
          assert.equal(options.body.get('code'), 'browser-code');
          const verifier = options.body.get('code_verifier');
          assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
          return Response.json(grant);
        }
        if (revocation) {
          assert.equal(options.body.get('refresh_token'), 'rotated');
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        assert.equal(options.body.get('refresh_token'), 'refresh');
        refreshes++;
        return Response.json({
          ...grant,
          access_token: 'renewed',
          refresh_token: 'rotated',
        });
      }
      default:
        assert.fail('Unexpected server URL');
    }
  };

  const store = {
    read: async () => saved,
    write: async (entry) => {
      saved = entry;
    },
    lock: async (work) => work(),
  };
  const authorize = async (url) => {
    assert.equal(url.origin, resource.origin);
    assert.equal(url.pathname, '/api/oauth/apps/authorize');
    assert.equal(url.searchParams.get('scope'), 'library:read');
    assert.equal(url.searchParams.get('client_id'), `client-${registrations}`);
    assert.equal(url.searchParams.get('resource'), resource.href);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    challenge = url.searchParams.get('code_challenge');
    redirectUri = url.searchParams.get('redirect_uri');
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', 'browser-code');
    callback.searchParams.set('iss', resource.origin);
    callback.searchParams.set('state', 'wrong');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('iss', 'https://wrong.example');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('iss', resource.origin);
    const completed = await fetch(callback);
    assert.equal(completed.status, 200);
    assert.equal(await completed.text(), message('completeCallback'));
  };

  const oauth = new LibraryOAuth(resource, store, fakeFetch, authorize);
  assert.deepEqual(await Promise.all([oauth.token(), oauth.token()]), ['access', 'access']);
  assert.equal(registrations, 1);
  assert.deepEqual(await Promise.all([oauth.token('access'), oauth.token('access')]), ['renewed', 'renewed']);
  assert.equal(refreshes, 1);
  assert.equal(saved.refreshToken, 'rotated');
  revocation = true;
  assert.equal(await oauth.token('renewed'), 'access');
  assert.equal(registrations, 2);
  assert.equal(saved.clientId, 'client-2');
});

test('fails closed when the Library points OAuth at a different origin', async () => {
  const oauth = new LibraryOAuth(
    resource,
    { lock: async (work) => work(), read: async () => undefined },
    async (url) => {
      assert.match(url.href, /oauth-protected-resource/);
      return Response.json({
        resource: resource.href,
        authorization_servers: ['https://other.example'],
        scopes_supported: ['library:read'],
      });
    },
    async () => assert.fail('No browser should open'),
  );
  await assert.rejects(() => oauth.token(), { message: message('metadata') });
});

test('the stdio connector advertises only read-only tools before sign-in', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { fileURLToPath } = await import('node:url');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url)), 'https://library.example'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(({ name }) => name),
      ['search_library', 'list_albums', 'get_album'],
    );
    assert.deepEqual(
      tools.map(({ title }) => title),
      [message('searchTitle'), message('listTitle'), message('albumTitle')],
    );
    assert.ok(tools.every(({ annotations }) => annotations.readOnlyHint));
    assert.ok(tools.every(({ annotations }) => annotations.destructiveHint === false));
    assert.equal((await client.callTool({ name: 'create_album' })).isError, true);
  } finally {
    await client.close();
  }
});

test('HTTPS checks the issuing CA and the Library hostname', async () => {
  const { execFile, execFileSync } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { createServer } = await import('node:https');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  const { libraryHttps } = await import('./https.mjs');
  const scratch = await mkdtemp(join(tmpdir(), 'frameleaf-tls-'));
  const certificate = join(scratch, 'certificate.pem');
  const key = join(scratch, 'key.pem');
  let server;
  let untrusted;

  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        certificate,
      ],
      { stdio: 'ignore' },
    );
    server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (_, response) => {
      response.end('Library');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const address = new URL(`https://localhost:${port}/api/mcp/assistant`);
    untrusted = libraryHttps(address);
    await assert.rejects(untrusted.fetch(address), (error) => error.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');

    const testScript = `
      import assert from 'node:assert/strict';
      import { libraryHttps } from ${JSON.stringify(new URL('./https.mjs', import.meta.url).href)};
      const address = new URL(${JSON.stringify(address.href)});
      const trusted = libraryHttps(address);
      try {
        assert.equal(await (await trusted.fetch(address)).text(), 'Library');
        assert.throws(() => trusted.fetch('https://other.example'), { message: ${JSON.stringify(message('unexpectedAddress'))} });
      } finally {
        await trusted.close();
      }
      const wrongHostname = new URL(${JSON.stringify(`https://127.0.0.1:${port}/api/mcp/assistant`)});
      const check = libraryHttps(wrongHostname);
      try {
        await assert.rejects(check.fetch(wrongHostname), (error) => error.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
      } finally {
        await check.close();
      }
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', testScript], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
    });
  } finally {
    await untrusted?.close();
    server?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('all Library languages have the same messages and the English manifest matches the catalogue', () => {
  assert.deepEqual(Object.keys(messages).sort(), ['da', 'de', 'en', 'es', 'fr', 'it', 'nb', 'nl', 'pl', 'pt', 'sv']);
  const keys = Object.keys(messages.en).sort();
  for (const [locale, text] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(text).sort(), keys);
    for (const key of keys) {
      assert.ok(text[key].trim());
      if (locale !== 'en') {
        assert.notEqual(text[key], messages.en[key]);
      }
    }
    assert.match(text.oauth, /\{status\}/);
  }
  assert.equal(localeMessages('fr-CA'), messages.fr);
  assert.equal(localeMessages('nb_NO'), messages.nb);
  assert.equal(localeMessages('no-NO'), messages.nb);
  assert.equal(localeMessages('ja-JP'), messages.en);
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.description, messages.en.extensionDescription);
  assert.equal(manifest.user_config.library_url.title, messages.en.libraryAddress);
  assert.equal(manifest.user_config.library_url.description, messages.en.libraryAddressHelp);
  // MCPB 0.4 allows only name and description here; MCP tools/list carries titles.
  assert.ok(manifest.tools.every((tool) => Object.keys(tool).sort().join(',') === 'description,name'));
  assert.deepEqual(
    manifest.tools.map(({ description }) => description),
    [messages.en.searchDescription, messages.en.listDescription, messages.en.albumDescription],
  );
});
