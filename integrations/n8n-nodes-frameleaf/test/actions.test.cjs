const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const album = '11111111-1111-4111-8111-111111111111',
	asset = '22222222-2222-4222-8222-222222222222';
function node() {
	const file = path.join(__dirname, '../dist/nodes/Frameleaf/Frameleaf.node.js');
	assert.ok(fs.existsSync(file), 'Frameleaf actions are not implemented');
	return new (require(file).Frameleaf)();
}
function context(parameters, request) {
	return {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({
			libraryUrl: 'https://library.example',
			permissionProfile: 'library:read albums:write tags:write',
			oauthTokenData: {
				access_token: 'synthetic-access',
				resource: 'https://library.example/api/connect',
				scope: 'library:read albums:write tags:write',
			},
		}),
		getNodeParameter: (name, index, fallback) => parameters[name] ?? fallback,
		getWorkflow: () => ({ id: 'workflow' }),
		getNode: () => ({ id: 'node', name: 'Frameleaf' }),
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => false,
		helpers: {
			httpRequest: async (options) => {
				assert.equal(options.headers.Authorization, 'Bearer synthetic-access');
				return request(options);
			},
			prepareBinaryData: async (bytes, name, mime) => ({
				data: bytes.toString('base64'),
				fileName: name,
				mimeType: mime,
			}),
		},
	};
}
test('search paginates within Connect and preserves paired item data', async () => {
	const action = node();
	let pages = 0;
	const output = await action.execute.call(
		context({ operation: 'search', query: 'synthetic', albumId: album, limit: 101 }, async (r) => {
			assert.equal(new URL(r.url).pathname, '/api/connect/assets');
			assert.equal(r.qs.albumId, album);
			pages++;
			return {
				items: Array.from({ length: pages === 1 ? 100 : 1 }, (_, i) => ({ id: `${pages}-${i}` })),
				total: 101,
			};
		}),
	);
	assert.equal(output[0].length, 101);
	assert.equal(pages, 2);
	assert.deepEqual(output[0][100].pairedItem, { item: 0 });
});
test('writes a stable Source ID bound to the saved workflow and node', async () => {
	const action = node();
	const ids = [];
	const c = context(
		{ operation: 'createAlbum', sourceId: 'source-event', name: 'Synthetic', workspace: 'photo' },
		async (r) => {
			ids.push(r.body.requestId);
			return { id: album };
		},
	);
	await action.execute.call(c);
	await action.execute.call(c);
	assert.equal(ids[0], ids[1]);
	assert.match(ids[0], /^[a-f0-9]{64}$/);
});
test('returns rendition data using n8n binary storage without temporary media URLs', async () => {
	const output = await node().execute.call(
		context(
			{
				operation: 'download',
				assetId: asset,
				variant: 'display',
				binaryProperty: 'data',
				maximumMiB: 5,
			},
			async (r) => {
				assert.equal(r.maxResponseBodyBytes, 5 * 1024 * 1024);
				assert.equal(r.disableFollowRedirect, true);
				return { body: Buffer.from('synthetic'), headers: { 'content-type': 'image/jpeg' } };
			},
		),
	);
	assert.equal(output[0][0].binary.data.data, Buffer.from('synthetic').toString('base64'));
	assert.equal(output[0][0].json.assetId, asset);
});

test('does not expose private transport or binary-helper errors in workflow output', async () => {
	const c = context({ operation: 'upload', inputBinaryField: 'data' }, async () =>
		assert.fail('No request expected'),
	);
	c.continueOnFail = () => true;
	c.helpers.assertBinaryData = () => {
		throw new Error('private-filename-and-token');
	};
	const output = await node().execute.call(c);
	assert.equal(
		output[0][0].json.error,
		'Frameleaf operation failed. Check the connection and input, then retry.',
	);
});
