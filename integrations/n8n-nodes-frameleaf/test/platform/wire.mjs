// Exercise the actual released native HTTP/OAuth helpers with a strict synthetic wire server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const { ConnectClient } = require('/qualification/dist/nodes/Frameleaf/client.js');
const { boundRequest } = require('/qualification/dist/credentials/request.js');
const {
	FrameleafOAuth2Api,
} = require('/qualification/dist/credentials/FrameleafOAuth2Api.credentials.js');
const credential = new FrameleafOAuth2Api();
const root = require
	.resolve('n8n-core')
	.replace('index.js', 'execution-engine/node-execution-context/utils/request-helpers/');
const { getRequestHelperFunctions } = require(`${root}factory.js`);
const albumId = '11111111-1111-4111-8111-111111111111',
	uploadId = '22222222-2222-4222-8222-222222222222',
	assetId = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('synthetic-only');
const digest = createHash('sha256').update(bytes).digest('hex');
let base,
	offset = 0,
	published = false,
	refreshes = 0;
const chunks = [];
const state = () => ({
	id: uploadId,
	offset,
	size: bytes.length,
	state: published ? 'published' : offset === bytes.length ? 'verified' : 'receiving',
	...(published ? { receipt: { assetId, status: 'created', sha256: digest } } : {}),
});
const server = createServer(async (req, res) => {
	try {
		const parts = [];
		for await (const part of req) parts.push(part);
		const body = Buffer.concat(parts);
		const url = new URL(req.url, base);
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/token') {
			const form = new URLSearchParams(body.toString());
			assert.equal(form.get('refresh_token'), 'synthetic-r1');
			assert.equal(form.get('resource'), `${base}/api/connect`);
			assert.equal(form.get('scope'), null);
			assert.equal(++refreshes, 1);
			return res.end(
				JSON.stringify({
					access_token: 'synthetic-a2',
					refresh_token: 'synthetic-r2',
					scope: 'library:read photos:upload',
					token_type: 'Bearer',
					expires_in: 3600,
				}),
			);
		}
		if (req.headers.authorization !== 'Bearer synthetic-a2') {
			res.writeHead(401);
			return res.end('{}');
		}
		if (url.pathname.endsWith('/capabilities'))
			return res.end(
				JSON.stringify({
					protocolVersion: 1,
					scopes: ['library:read', 'photos:upload'],
					albums: [{ id: albumId, workspace: 'photo', canWrite: true }],
					limits: { maxUploadBytes: 100, maxAppendBytes: 4 },
					supportedTypes: { upload: { photo: ['image/png'] } },
				}),
			);
		if (url.pathname.endsWith('/rendition')) {
			res.setHeader('Content-Type', 'image/png');
			return res.end(bytes);
		}
		if (url.pathname.endsWith('/uploads') && req.method === 'POST') {
			assert.equal(JSON.parse(body).sha256, digest);
			return res.end(JSON.stringify(state()));
		}
		if (req.method === 'PATCH') {
			assert.equal(req.headers['content-type'], 'application/partial-upload');
			assert.equal(req.headers['upload-offset'], String(offset));
			assert.equal(
				req.headers['repr-digest'],
				`sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:`,
			);
			offset += body.length;
			chunks.push(body);
			return res.end(JSON.stringify(state()));
		}
		if (url.pathname.endsWith('/commit')) {
			assert.equal(offset, bytes.length);
			published = true;
			return res.end(JSON.stringify(state().receipt));
		}
		res.writeHead(404);
		res.end('{}');
	} catch (error) {
		console.error(error);
		res.writeHead(500);
		res.end('{}');
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
let stored = {
	libraryUrl: base,
	permissionProfile: 'library:read albums:write tags:write photos:upload',
	grantType: 'pkce',
	clientId: 'synthetic-client',
	clientSecret: '',
	authentication: 'body',
	scope: 'library:read photos:upload',
	resourceUrl: `${base}/api/connect`,
	accessTokenUrl: `${base}/token`,
	oauthTokenData: {
		access_token: 'synthetic-a1',
		refresh_token: 'synthetic-r1',
		scope: 'library:read photos:upload',
		resource: `${base}/api/connect`,
		token_type: 'Bearer',
		expires_in: 1,
	},
};
const node = {
	id: 'synthetic',
	name: 'Synthetic',
	type: 'frameleaf',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
	credentials: { frameleafOAuth2Api: { id: 'synthetic', name: 'Synthetic' } },
};
const additional = {
	credentialsHelper: {
		getDecrypted: async () => structuredClone(stored),
		runPreAuthentication: async (_context, value) => await credential.preAuthentication(value),
		updateCredentialsOauthTokenData: async (_id, _type, value) => {
			stored = structuredClone(value);
		},
	},
};
const context = {
	getMode: () => 'manual',
	getCredentials: async () => structuredClone(stored),
	logger: { debug() {}, warn() {} },
	helpers: getRequestHelperFunctions({}, node, additional),
};
const client = new ConnectClient(base, (options) => boundRequest(context, base, options));
try {
	await Promise.all(Array.from({ length: 10 }, () => client.capabilities()));
	assert.equal(refreshes, 1);
	assert.equal(stored.oauthTokenData.resource, `${base}/api/connect`);
	assert.equal(stored.oauthTokenData.refresh_token, 'synthetic-r2');
	const receipt = await client.upload(bytes, {
		requestId: 'synthetic-source',
		albumId,
		workspace: 'photo',
		filename: 'synthetic.png',
		contentType: 'image/png',
		sourceDate: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(receipt.assetId, assetId);
	assert.deepEqual(Buffer.concat(chunks), bytes);
	const rendition = await client.download(assetId, 'display', 100);
	assert.deepEqual(rendition.body, bytes);
	await assert.rejects(client.download(assetId, 'display', 2));
	console.log(
		JSON.stringify({
			nativeHttp: true,
			concurrentRefreshes: refreshes,
			resumableUpload: true,
			binaryRendition: true,
			responseLimit: true,
		}),
	);
} finally {
	await new Promise((resolve) => server.close(resolve));
}
