import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';

const nativeRequire = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const { CREDENTIAL_BLANKING_VALUE } = nativeRequire('n8n-workflow');
const n8n = 'http://127.0.0.1:5678';
const issuer = 'http://127.0.0.1:5689';
const scopes = [
	'library:read',
	'library:download',
	'albums:write',
	'tags:write',
	'photos:upload',
	'boards:upload',
	'events:read',
];
const codes = new Map();
const requests = [];
const cookie = new Map();
const server = createServer(async (req, res) => {
	const url = new URL(req.url, issuer);
	let text = '';
	for await (const chunk of req) text += chunk;
	res.setHeader('Content-Type', 'application/json');
	res.setHeader('Cache-Control', 'no-store');
	if (url.pathname === '/.well-known/oauth-protected-resource/api/connect')
		return res.end(
			JSON.stringify({
				resource: `${issuer}/api/connect`,
				authorization_servers: [issuer],
				scopes_supported: scopes,
			}),
		);
	if (url.pathname === '/.well-known/oauth-authorization-server')
		return res.end(
			JSON.stringify({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				registration_endpoint: `${issuer}/register`,
				revocation_endpoint: `${issuer}/revoke`,
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				token_endpoint_auth_methods_supported: ['none'],
				code_challenge_methods_supported: ['S256'],
				scopes_supported: scopes,
			}),
		);
	if (url.pathname === '/register') {
		const registration = JSON.parse(text);
		requests.push({
			kind: 'registration',
			scope: registration.scope,
			grant_types: registration.grant_types,
			token_endpoint_auth_method: registration.token_endpoint_auth_method,
		});
		return res.end(
			JSON.stringify({
				client_id: 'synthetic-client',
				token_endpoint_auth_method: 'none',
				redirect_uris: registration.redirect_uris,
			}),
		);
	}
	if (url.pathname === '/api/oauth/apps/authorize') {
		assert.equal(url.searchParams.get('resource'), `${issuer}/api/connect`);
		assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
		assert.ok(url.searchParams.get('state'));
		const code = randomBytes(24).toString('hex');
		codes.set(code, {
			challenge: url.searchParams.get('code_challenge'),
			redirect: url.searchParams.get('redirect_uri'),
			scope: url.searchParams.get('scope'),
		});
		requests.push({
			kind: 'authorization',
			scope: url.searchParams.get('scope'),
			pkce: true,
			resource: true,
		});
		const callback = new URL(url.searchParams.get('redirect_uri'));
		callback.searchParams.set('code', code);
		callback.searchParams.set('state', url.searchParams.get('state'));
		res.writeHead(302, { Location: callback.href });
		return res.end();
	}
	if (url.pathname === '/api/oauth/apps/token') {
		const body = new URLSearchParams(text);
		if (body.get('grant_type') === 'authorization_code') {
			const pending = codes.get(body.get('code'));
			assert.ok(pending);
			codes.delete(body.get('code'));
			assert.equal(body.get('client_id'), 'synthetic-client');
			assert.equal(body.get('client_secret'), null);
			assert.equal(body.get('scope'), null);
			assert.equal(body.get('redirect_uri'), pending.redirect);
			assert.equal(body.get('resource'), `${issuer}/api/connect`);
			assert.equal(
				createHash('sha256').update(body.get('code_verifier')).digest('base64url'),
				pending.challenge,
			);
			requests.push({
				kind: 'exchange',
				publicClient: true,
				pkce: true,
				resource: true,
				scope: pending.scope,
			});
			return res.end(
				JSON.stringify({
					access_token: 'synthetic-access',
					refresh_token: 'synthetic-refresh',
					expires_in: 3600,
					token_type: 'Bearer',
					scope: pending.scope,
				}),
			);
		}
	}
	if (url.pathname === '/api/connect/capabilities') {
		assert.equal(req.headers.authorization, 'Bearer synthetic-access');
		requests.push({ kind: 'connection-test', nativePreAuthentication: true });
		return res.end(JSON.stringify({ protocolVersion: 1 }));
	}
	if (url.pathname === '/revoke') return res.end('{}');
	res.writeHead(404);
	res.end('{}');
});
await new Promise((resolve) => server.listen(5689, '127.0.0.1', resolve));
const api = async (path, body, method = body ? 'POST' : 'GET') => {
	const response = await fetch(`${n8n}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			Cookie: [...cookie.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
			'browser-id': 'synthetic-qualification-browser',
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	for (const line of response.headers.getSetCookie()) {
		const [name, ...parts] = line.split(';')[0].split('=');
		cookie.set(name, parts.join('='));
	}
	const text = await response.text();
	assert.ok(response.ok, `${path}: HTTP ${response.status}: ${text.slice(0, 250)}`);
	const value = JSON.parse(text);
	return value.data ?? value;
};
try {
	for (let attempt = 0; attempt < 120; attempt++) {
		const ready = await fetch(`${n8n}/rest/settings`).catch(() => undefined);
		if (ready?.headers.get('content-type')?.includes('application/json')) break;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const setup = await api('/rest/settings');
	if (setup.userManagement?.showSetupOnFirstLoad)
		await api('/rest/owner/setup', {
			email: 'integration@example.invalid',
			firstName: 'Synthetic',
			lastName: 'Qualification',
			password: randomBytes(32).toString('base64url'),
		});
	else throw new Error('Use a fresh disposable n8n database.');
	const nodeTypes = await api('/types/nodes.json');
	assert.ok(nodeTypes.some((x) => x.name === 'n8n-nodes-frameleaf.frameleaf'));
	console.log(JSON.stringify({ installedPackageNodes: true }));
	for (const dcr of [false]) {
		const data = { libraryUrl: issuer, clientId: 'synthetic-client' };
		const credential = await api('/rest/credentials', {
			name: `Frameleaf qualification ${dcr ? 'DCR' : 'static'}`,
			type: 'frameleafOAuth2Api',
			data,
		});
		for (const profile of [
			'library:read',
			'photos:upload',
			'boards:upload',
			'library:read albums:write tags:write photos:upload',
			'library:read',
		]) {
			if (requests.some((x) => x.kind === 'exchange'))
				await api(
					`/rest/credentials/${credential.id}`,
					{
						name: credential.name,
						type: 'frameleafOAuth2Api',
						data: { ...data, permissionProfile: profile },
					},
					'PATCH',
				);
			const authorization = await api(
				`/rest/oauth2-credential/auth?id=${encodeURIComponent(credential.id)}`,
			);
			const redirect = await fetch(authorization, { redirect: 'manual' });
			assert.equal(redirect.status, 302);
			const callback = await fetch(redirect.headers.get('location'), {
				headers: {
					Cookie: [...cookie.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
					'browser-id': 'synthetic-qualification-browser',
				},
			});
			assert.equal(callback.status, 200);
			const page = await callback.text();
			assert.ok(!page.includes('Error in OAuth'), 'Native callback reported an error.');
			const exchanged = requests.filter((x) => x.kind === 'exchange').at(-1);
			assert.ok(exchanged);
			console.log(
				JSON.stringify({
					mode: dcr ? 'DCR' : 'static',
					credentialSaved: true,
					roundTrip: true,
					requestedScope: profile,
					actualScope: exchanged.scope,
					leastPrivilege: exchanged.scope === profile,
				}),
			);
			assert.equal(exchanged.scope, profile);
			const saved = await api(`/rest/credentials/${credential.id}?includeData=true`);
			assert.equal(saved.data.oauthTokenData, true); // Native REST deliberately redacts token data.
			const tested = await api('/rest/credentials/test', {
				credentials: {
					id: credential.id,
					name: credential.name,
					type: 'frameleafOAuth2Api',
					data: { ...saved.data, oauthTokenData: CREDENTIAL_BLANKING_VALUE },
				},
			});
			assert.equal(
				tested.status,
				'OK',
				`Native OAuth connection status must succeed: ${tested.message}`,
			);
		}
		// Read only this disposable synthetic credential through n8n's supported export CLI.
		// No token values are printed or retained outside the container's tmpfs.
		const exportedPath = '/tmp/frameleaf-credential.json';
		await promisify(execFile)(
			'n8n',
			['export:credentials', `--id=${credential.id}`, '--decrypted', `--output=${exportedPath}`],
			{ timeout: 60000 },
		);
		try {
			const [exported] = JSON.parse(await readFile(exportedPath, 'utf8'));
			assert.equal(exported.data.oauthTokenData.resource, `${issuer}/api/connect`);
			assert.equal(exported.data.oauthTokenData.scope, 'library:read');
			const require = createRequire(import.meta.url);
			const {
				FrameleafOAuth2Api,
			} = require('/qualification/dist/credentials/FrameleafOAuth2Api.credentials.js');
			await new FrameleafOAuth2Api().preAuthentication(exported.data);
			console.log(JSON.stringify({ nativeStoredResource: true, providerEchoedResource: false }));
		} finally {
			await unlink(exportedPath);
		}
	}
	console.log(JSON.stringify({ requests }));
} finally {
	await new Promise((resolve) => server.close(resolve));
}
