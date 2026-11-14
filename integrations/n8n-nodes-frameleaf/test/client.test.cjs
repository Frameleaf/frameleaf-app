const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function implementation() {
	const file = path.join(__dirname, '../dist/nodes/Frameleaf/client.js');
	assert.ok(fs.existsSync(file), 'Connect client is not implemented');
	return require(file);
}
const albumId = '11111111-1111-4111-8111-111111111111';
const uploadId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const capabilities = {
	protocolVersion: 1,
	scopes: ['photos:upload'],
	albums: [{ id: albumId, workspace: 'photo', canWrite: true }],
	limits: { maxUploadBytes: 100, maxAppendBytes: 3 },
	supportedTypes: { upload: { photo: ['image/png'], design: [] } },
};
const input = {
	requestId: 'stable-event',
	albumId,
	workspace: 'photo',
	filename: 'synthetic.png',
	contentType: 'image/png',
	sourceDate: '2026-01-01T00:00:00.000Z',
};
test('rejects unsafe origins and token scopes left over after a profile change', () => {
	const { origin, validateConnection, sourceRequestId } = implementation();
	for (const url of [
		'https://u:p@example.com',
		'https://example.com/path',
		'https://example.com?q=1',
		'file:///tmp',
		'https://example.com/#secret',
	])
		assert.throws(() => origin(url));
	assert.equal(origin('http://192.168.1.2:2283/'), 'http://192.168.1.2:2283');
	assert.throws(() =>
		validateConnection({
			libraryUrl: 'https://example.com',
			permissionProfile: 'library:read',
			oauthTokenData: { scope: 'library:read photos:upload' },
		}),
	);
	assert.throws(() =>
		validateConnection({
			libraryUrl: 'https://example.com',
			permissionProfile: 'people:read',
			oauthTokenData: { scope: 'people:read' },
		}),
	);
	const first = sourceRequestId('workflow', 'node', 'upload', 'source-1');
	assert.equal(first, sourceRequestId('workflow', 'node', 'upload', 'source-1'));
	assert.notEqual(first, sourceRequestId('workflow', 'node-2', 'upload', 'source-1'));
	assert.throws(() => sourceRequestId(undefined, 'node', 'upload', 'source-1'));
});
test('uploads exact bytes at durable offsets and recovers an uncertain append and commit', async () => {
	const { ConnectClient } = implementation();
	const bytes = Buffer.from('synthetic');
	const digest = createHash('sha256').update(bytes).digest('hex');
	let offset = 0,
		committed = false,
		lostAppend = true,
		lostCommit = true;
	const chunks = [];
	let starts = 0;
	const state = () => ({
		id: uploadId,
		offset,
		size: bytes.length,
		state: committed ? 'published' : offset === bytes.length ? 'verified' : 'receiving',
		...(committed ? { receipt: { assetId, status: 'created', sha256: digest } } : {}),
	});
	const request = async (options) => {
		const url = new URL(options.url);
		assert.equal(url.origin, 'https://library.example');
		assert.equal(options.disableFollowRedirect, true);
		if (url.pathname.endsWith('/capabilities')) return capabilities;
		if (options.method === 'POST' && url.pathname.endsWith('/uploads')) {
			starts++;
			assert.equal(options.body.sha256, digest);
			assert.equal(options.body.fileCreatedAt, input.sourceDate);
			return state();
		}
		if (options.method === 'PATCH') {
			assert.equal(options.headers['Upload-Offset'], String(offset));
			assert.equal(
				options.headers['Repr-Digest'],
				`sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:`,
			);
			chunks.push(options.body);
			offset += options.body.length;
			if (lostAppend) {
				lostAppend = false;
				throw new Error('Synthetic lost response');
			}
			return state();
		}
		if (url.pathname.endsWith('/commit')) {
			committed = true;
			if (lostCommit) {
				lostCommit = false;
				throw new Error('Synthetic lost response');
			}
			return state().receipt;
		}
		if (options.method === 'GET') return state();
		assert.fail('Unexpected request');
	};
	const client = new ConnectClient('https://library.example', request);
	assert.equal((await client.upload(bytes, input)).assetId, assetId);
	assert.equal(Buffer.concat(chunks).toString(), bytes.toString());
	assert.equal((await client.upload(bytes, input)).assetId, assetId);
	assert.equal(starts, 2);
	assert.equal(chunks.length, 3);
});
test('denies an unauthorized destination and never retries a conflicting Source ID as a new request', async () => {
	const { ConnectClient } = implementation();
	let writes = 0;
	const client = new ConnectClient('https://library.example', async (options) => {
		if (options.method === 'GET') return capabilities;
		writes++;
		throw { statusCode: 409 };
	});
	await assert.rejects(
		client.upload(Buffer.from('a'), { ...input, workspace: 'design' }),
		/destination|permission/i,
	);
	assert.equal(writes, 0);
	await assert.rejects(client.upload(Buffer.from('a'), input), /409/);
	assert.equal(writes, 1);
});
test('returns a redacted retry delay without hammering a rate-limited service', async () => {
	const { ConnectClient } = implementation();
	let requests = 0;
	const client = new ConnectClient('https://limited.example', async () => {
		requests++;
		throw {
			statusCode: 429,
			response: { headers: { 'retry-after': '120' } },
			message: 'private token and filename',
		};
	});
	await assert.rejects(
		client.json('GET', '/albums'),
		(e) => e.message.includes('120') && !e.message.includes('private'),
	);
	assert.equal(requests, 1);
});
test('changing the Library URL cannot send the previous server token to a new host', () => {
	const { validateConnection } = implementation();
	assert.throws(
		() =>
			validateConnection({
				libraryUrl: 'https://other.example',
				permissionProfile: 'library:read',
				oauthTokenData: { scope: 'library:read', resource: 'https://first.example/api/connect' },
			}),
		/Reconnect/,
	);
});

test('a completed upload receipt remains retrievable when that upload used the remaining quota', async () => {
	const { ConnectClient } = implementation();
	const bytes = Buffer.from('a');
	const digest = createHash('sha256').update(bytes).digest('hex');
	const client = new ConnectClient('https://library.example', async (r) =>
		r.url.endsWith('/capabilities')
			? { ...capabilities, limits: { maxUploadBytes: 0, maxAppendBytes: 0 } }
			: {
					id: uploadId,
					offset: 1,
					size: 1,
					state: 'published',
					receipt: { assetId, status: 'created', sha256: digest },
				},
	);
	assert.equal((await client.upload(bytes, input)).assetId, assetId);
});

test('generic retries and another workflow wait out Retry-After without another HTTP request', async () => {
	const { ConnectClient } = implementation();
	let attempts = 0;
	const limited = async () => {
		attempts++;
		throw { statusCode: 429, response: { headers: { 'retry-after': '120' } } };
	};
	const first = new ConnectClient('https://rate.example', limited);
	await assert.rejects(first.json('GET', '/albums'), /120/);
	await assert.rejects(first.json('GET', '/albums'), /Retry after/);
	await assert.rejects(
		new ConnectClient('https://rate.example', limited).json('GET', '/albums'),
		/Retry after/,
	);
	assert.equal(attempts, 1);
});
