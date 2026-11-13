import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));

test('connection accepts canonical HTTPS origins and rejects endpoint or credential injection', async () => {
  const parameters = await read('connection/parameters.json');
  const server = parameters.find(({ name }) => name === 'serverUrl');
  const pattern = new RegExp(server.validate.pattern);
  for (const value of ['https://library.example.com', 'https://photos.example.com:8443']) {
    assert.match(value, pattern);
  }
  for (const value of ['http://library.example.com', 'https://user:password@library.example.com',
    'https://library.example.com/', 'https://library.example.com/api', 'https://library.example.com?x=y',
    'https://library.example.com#x', 'https://LIBRARY.example.com', 'https://library.example.com:65536',
    'https://library.example.com/../api', 'https://library.example.com\\@other.example.com',
    'https://library.example.com%2fother', 'https://library.example.com\n']) {
    assert.doesNotMatch(value, pattern, value);
  }
  assert.equal(server.editable, false, 'stored tokens must never be sent to an edited origin');
  assert.deepEqual(parameters.map(({ name }) => name), ['serverUrl', 'frameleafClientId']);
  assert.equal(parameters[1].editable, false);
  const clientPattern = new RegExp(parameters[1].validate.pattern);
  assert.match('public-client_01', clientPattern);
  assert.doesNotMatch('injected\nclient', clientPattern);
});

test('OAuth binds PKCE, exact callback and Connect resource without a client secret', async () => {
  const connection = await read('connection/communication.json');
  const { authorize, token, refresh } = connection;
  assert.equal(authorize.qs.redirect_uri, '{{oauth.makeRedirectUri}}');
  assert.equal(token.body.redirect_uri, authorize.qs.redirect_uri);
  assert.equal(authorize.qs.resource, '{{parameters.serverUrl}}/api/connect');
  assert.equal(token.body.resource, authorize.qs.resource);
  assert.equal(refresh.body.resource, authorize.qs.resource);
  assert.equal(authorize.qs.code_challenge_method, 'S256');
  assert.equal(authorize.temp.code_verifier, '{{uuid}}{{uuid}}{{uuid}}');
  assert.equal(authorize.qs.code_challenge, "{{base64url(sha256(temp.code_verifier, 'base64'))}}");
  assert.equal(token.body.code_verifier, '{{temp.code_verifier}}');
  assert.equal(token.body.grant_type, 'authorization_code');
  assert.equal(refresh.body.grant_type, 'refresh_token');
  assert.equal(token.condition, undefined, 'authorization codes must never be retried as token.condition');
  assert.equal(authorize.qs.scope, 'library:read');
  for (const step of [authorize.qs, token.body, refresh.body]) {
    assert.equal(step.client_id, '{{parameters.frameleafClientId}}');
    assert.equal(step.client_secret, undefined);
  }
  assert.deepEqual(await read('connection/scope.json'), ['library:read']);
  assert.doesNotMatch(JSON.stringify(connection), /apiKey|x-api-key|client_secret|parameters\.scopes/);
});

test('native store replaces both rotating tokens and excludes secrets and URLs from logs', async () => {
  const connection = await read('connection/communication.json');
  for (const name of ['token', 'refresh']) {
    const step = connection[name];
    assert.equal(step.url, '{{parameters.serverUrl}}/api/oauth/apps/token');
    assert.equal(step.method, 'POST');
    assert.equal(step.type, 'urlencoded');
    assert.equal(step.response.data.accessToken, '{{body.access_token}}');
    assert.equal(step.response.data.refreshToken, '{{body.refresh_token}}');
    assert.equal(step.response.data.expires, '{{addSeconds(now, body.expires_in)}}');
    assert.ok(step.response.valid.includes('body.refresh_token'));
    for (const key of ['request.url', 'request.body', 'response.body', 'response.headers']) {
      assert.ok(step.log.sanitize.includes(key), `${name}: ${key}`);
    }
    assert.equal(step.repeat, undefined, 'ambiguous refresh must not retry a consumed token');
  }
  assert.equal(connection.refresh.condition, '{{data.expires < addSeconds(now, 60)}}');
  assert.equal(connection.invalidate.url, '{{parameters.serverUrl}}/api/oauth/apps/revoke');
  assert.equal(connection.invalidate.body.token, '{{data.refreshToken}}');
  assert.equal(connection.invalidate.body.client_id, '{{parameters.frameleafClientId}}');
  assert.equal(connection.info.url, '{{parameters.serverUrl}}/api/connect/capabilities');
  assert.equal(connection.info.headers.authorization, 'Bearer {{connection.accessToken}}');
  assert.ok(connection.info.response.valid.includes('body.protocolVersion = 1'));
  assert.ok(connection.info.log.sanitize.includes('response.body'));
  assert.equal(connection.info.response.metadata.value, 'Frameleaf');
});

test('all supplied locales cover the complete connection text without host localization extensions', async () => {
  const messages = await read('locales.json');
  assert.deepEqual(Object.keys(messages).sort(), ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb_NO'].sort());
  const englishKeys = Object.keys(messages.en).sort();
  for (const [locale, text] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(text).sort(), englishKeys, locale);
    for (const [key, value] of Object.entries(text)) {
      assert.equal(typeof value, 'string');
      assert.ok(value.trim().length, `${locale}.${key}`);
      if (locale !== 'en') assert.notEqual(value, messages.en[key], `${locale}.${key}`);
    }
  }
});

test('locale renderer emits native parameter and communication shapes with no locale extension', async () => {
  const { render } = await import('../render.mjs');
  const messages = await read('locales.json');
  for (const [locale, text] of Object.entries(messages)) {
    const parameters = await render(locale, 'parameters');
    assert.equal(parameters[0].label, text.serverLabel);
    assert.equal(parameters[0].help, text.serverHelp);
    assert.equal(parameters[1].label, text.clientLabel);
    assert.equal(parameters[1].help, text.clientHelp);
    const communication = await render(locale, 'communication');
    for (const key of ['token', 'refresh', 'info', 'invalidate']) {
      assert.equal(communication[key].response.error.message, text.error);
    }
    assert.deepEqual(await render(locale, 'scope'), ['library:read']);
    assert.equal(await render(locale, 'help'), text.help);
    assert.equal(parameters[0].localization, undefined);
  }
  assert.deepEqual(await render('en', 'parameters'), await read('connection/parameters.json'));
  assert.deepEqual(await render('en', 'communication'), await read('connection/communication.json'));
  await assert.rejects(render('../en', 'parameters'), /Unsupported locale/);
  await assert.rejects(render('en', '../locales'), /Unsupported component/);
});
