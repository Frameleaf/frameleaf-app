const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
function poller() {
	const file = path.join(__dirname, '../dist/nodes/FrameleafTrigger/poll.js');
	assert.ok(fs.existsSync(file), 'Event polling is not implemented');
	return require(file).pollFeed;
}
const settings = { type: 'asset.ready', albumId: '', checkpoint: 'initial' };
test('sample data never changes a live checkpoint', async () => {
	const poll = poller();
	const state = { cursor: 'live' };
	const result = await poll(
		{
			json: async (method, path) => {
				assert.equal(path, '/events/sample');
				return { items: [{ deliveryId: 'sample' }] };
			},
		},
		state,
		settings,
		true,
		60000,
	);
	assert.equal(result[0].deliveryId, 'sample');
	assert.deepEqual(state, { cursor: 'live' });
});
test('initializes from now and persists a cursor across restart before draining ordered pages', async () => {
	const poll = poller();
	const state = {};
	let phase = 0;
	const client = {
		json: async (method, path, body, qs) => {
			assert.equal(path, '/events');
			if (phase++ === 0) {
				assert.equal(qs.start, 'now');
				return { items: [], nextCursor: 'c0', hasMore: false };
			}
			if (qs.cursor === 'c0')
				return { items: [{ deliveryId: 'one' }], nextCursor: 'c1', hasMore: true };
			return { items: [{ deliveryId: 'two' }], nextCursor: 'c2', hasMore: false };
		},
	};
	assert.deepEqual(await poll(client, state, settings, false, 60000), []);
	const restarted = JSON.parse(JSON.stringify(state));
	assert.deepEqual(
		(await poll(client, restarted, settings, false, 60000)).map((x) => x.deliveryId),
		['one', 'two'],
	);
	assert.equal(restarted.cursor, 'c2');
});
test('does not advance cursor after a later page fails or silently restart an expired cursor', async () => {
	const poll = poller();
	const state = {};
	await poll(
		{ json: async () => ({ items: [], nextCursor: 'c0', hasMore: false }) },
		state,
		settings,
		false,
		60000,
	);
	const before = structuredClone(state);
	await assert.rejects(
		poll(
			{
				json: async (m, p, b, q) => {
					if (q.cursor === 'c0')
						return { items: [{ deliveryId: 'one' }], nextCursor: 'c1', hasMore: true };
					throw new Error('410 expired');
				},
			},
			state,
			settings,
			false,
			60000,
		),
		/410/,
	);
	assert.deepEqual(state, before);
});
test('requires explicit checkpoint change for new filters', async () => {
	const poll = poller();
	const state = {};
	const client = { json: async () => ({ items: [], nextCursor: 'new', hasMore: false }) };
	await poll(client, state, settings, false, 60000);
	await assert.rejects(
		poll(client, state, { ...settings, type: 'studio.export.completed' }, false, 60000),
		/checkpoint/i,
	);
	await poll(
		client,
		state,
		{ ...settings, type: 'studio.export.completed', checkpoint: 'restart-1' },
		false,
		60000,
	);
	assert.equal(state.cursor, 'new');
});
