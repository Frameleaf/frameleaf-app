import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const require = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const { Container } = require('@n8n/di');
const { LockService } = require('@n8n/backend-common');
const modulePath = require
	.resolve('n8n-core')
	.replace('index.js', 'execution-engine/node-execution-context/utils/request-helpers/oauth.js');
const original = require(modulePath).requestOAuth2;
delete require.cache[modulePath];
const separateFlightMap = require(modulePath).requestOAuth2;
Container.get(LockService);

async function scenario(delay, independentFlights) {
	let attempts = 0,
		revoked = false,
		writes = 0,
		fallbackWarnings = 0;
	const rotationStarted = Promise.withResolvers();
	let origin;
	const server = createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/token') {
			const form = new URLSearchParams(body);
			assert.equal(form.get('client_id'), 'synthetic-client');
			assert.equal(form.get('resource'), `${origin}/api/connect`);
			assert.equal(form.get('scope'), null);
			attempts++;
			if (attempts > 1 || form.get('refresh_token') !== 'synthetic-r1') {
				revoked = true;
				res.writeHead(400);
				return res.end(JSON.stringify({ error: 'invalid_grant' }));
			}
			rotationStarted.resolve();
			await new Promise((resolve) => setTimeout(resolve, delay));
			return res.end(
				JSON.stringify({
					access_token: 'synthetic-a2',
					refresh_token: 'synthetic-r2',
					token_type: 'Bearer',
					expires_in: 3600,
				}),
			);
		}
		if (revoked) {
			res.writeHead(403);
			return res.end('{}');
		}
		if (req.headers.authorization !== 'Bearer synthetic-a2') {
			res.writeHead(401);
			return res.end('{}');
		}
		return res.end(JSON.stringify({ connected: true }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	let stored = {
		grantType: 'pkce',
		clientId: 'synthetic-client',
		clientSecret: '',
		authentication: 'body',
		scope: 'library:read',
		resourceUrl: `${origin}/api/connect`,
		accessTokenUrl: `${origin}/token`,
		oauthTokenData: {
			access_token: 'synthetic-a1',
			refresh_token: 'synthetic-r1',
			scope: 'library:read',
			token_type: 'Bearer',
			expires_in: 1,
			resource: `${origin}/api/connect`,
		},
	};
	const node = {
		name: 'Synthetic qualification',
		credentials: { frameleafOAuth2Api: { id: `synthetic-${delay}`, name: 'Synthetic' } },
		type: 'synthetic',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	const additionalData = {
		credentialsHelper: {
			async getDecrypted() {
				return structuredClone(stored);
			},
			async runPreAuthentication() {
				return undefined;
			},
			async updateCredentialsOauthTokenData(_id, _type, value) {
				writes++;
				stored = structuredClone(value);
			},
		},
	};
	const context = {
		getMode() {
			return 'manual';
		},
		async getCredentials() {
			return structuredClone(stored);
		},
		logger: {
			debug() {},
			warn(message) {
				if (message.includes('without cross-process coordination')) fallbackWarnings++;
			},
		},
		helpers: {
			async httpRequest(options) {
				const response = await fetch(options.url, {
					method: options.method,
					headers: options.headers,
				});
				const body = await response.json();
				if (!response.ok) {
					const error = new Error(`HTTP ${response.status}`);
					error.response = { status: response.status };
					throw error;
				}
				return body;
			},
		},
	};
	const request = (fn) =>
		fn.call(
			context,
			'frameleafOAuth2Api',
			{ method: 'GET', url: `${origin}/api/connect/capabilities` },
			node,
			additionalData,
			undefined,
			true,
		);
	try {
		const first = request(original);
		first.catch(() => {});
		await rotationStarted.promise;
		const rest = Array.from({ length: independentFlights ? 1 : 9 }, () =>
			request(independentFlights ? separateFlightMap : original),
		);
		const results = await Promise.allSettled([first, ...rest]);
		const result = {
			scenario: independentFlights
				? 'separate native flight maps, real lock timeout'
				: '10 concurrent requests, one native flight map',
			attempts,
			writes,
			revoked,
			fallbackWarnings,
			successful: results.filter((x) => x.status === 'fulfilled').length,
			total: results.length,
			persistedRotatedTokens: stored.oauthTokenData.refresh_token === 'synthetic-r2',
		};
		console.log(JSON.stringify(result));
		if (!independentFlights)
			assert.deepEqual(
				{ attempts, writes, revoked, successful: result.successful },
				{ attempts: 1, writes: 1, revoked: false, successful: 10 },
			);
		else
			assert.equal(attempts, 1, 'A rotating grant must not be refreshed again after lock timeout.');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}
await scenario(50, false);
if (process.argv.includes('--probe-queue')) await scenario(11000, true);
