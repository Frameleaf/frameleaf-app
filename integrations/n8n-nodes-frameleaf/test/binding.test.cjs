const assert = require('node:assert/strict');
const { test } = require('node:test');

function fixture() {
	const base = 'https://library.example';
	const credentials = {
		libraryUrl: base,
		permissionProfile: 'library:read',
		oauthTokenData: {
			access_token: 'synthetic-old',
			scope: 'library:read',
			resource: `${base}/api/connect`,
		},
	};
	const requests = [];
	let refreshes = 0;
	const context = {
		getCredentials: async () => structuredClone(credentials),
		helpers: {
			httpRequest: async (options) => {
				requests.push(options);
				if (requests.length === 1) throw { response: { status: 401 } };
				return { connected: true };
			},
			refreshOAuth2Token: async () => {
				refreshes++;
				return { ...credentials.oauthTokenData, access_token: 'synthetic-new' };
			},
		},
	};
	return { base, credentials, requests, context, refreshes: () => refreshes };
}

test('native refresh is revalidated before a request is signed', async () => {
	const { boundRequest } = require('../dist/credentials/request.js');
	const f = fixture();
	assert.deepEqual(
		await boundRequest(f.context, f.base, { method: 'GET', url: `${f.base}/api/connect/albums` }),
		{ connected: true },
	);
	assert.equal(f.refreshes(), 1);
	assert.equal(f.requests.length, 2);
	assert.equal(f.requests[1].headers.Authorization, 'Bearer synthetic-new');
});

test('a changed resource returned by native refresh stops the retry', async () => {
	const { boundRequest } = require('../dist/credentials/request.js');
	const f = fixture();
	f.context.helpers.refreshOAuth2Token = async () => ({
		...f.credentials.oauthTokenData,
		access_token: 'synthetic-other',
		resource: 'https://other.example/api/connect',
	});
	await assert.rejects(
		boundRequest(f.context, f.base, { method: 'GET', url: `${f.base}/api/connect/albums` }),
		/Reconnect/,
	);
	assert.equal(f.requests.length, 1);
});

test('a connection change before dispatch or an unrelated destination fails closed', async () => {
	const { boundRequest } = require('../dist/credentials/request.js');
	for (const change of ['connection', 'destination']) {
		const f = fixture();
		if (change === 'connection') f.credentials.libraryUrl = 'https://other.example';
		await assert.rejects(
			boundRequest(f.context, f.base, {
				method: 'GET',
				url:
					change === 'destination'
						? 'https://other.example/api/connect/albums'
						: `${f.base}/api/connect/albums`,
			}),
			/Reconnect|destination/,
		);
		assert.equal(f.requests.length, 0);
	}
});
