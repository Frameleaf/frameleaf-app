import type { IDataObject } from 'n8n-workflow';
import type { ConnectClient, Feed } from '../Frameleaf/client';
import { uuid, SafeMessageError } from '../Frameleaf/client';

interface Settings {
	type: string;
	albumId: string;
	checkpoint: string;
}
export async function pollFeed(
	client: Pick<ConnectClient, 'json'>,
	state: IDataObject,
	settings: Settings,
	sample: boolean,
	budgetMs: number,
): Promise<IDataObject[]> {
	const filters: IDataObject = {
		type: settings.type,
		...(settings.albumId ? { albumId: uuid(settings.albumId) } : {}),
	};
	if (sample) return (await client.json<Feed>('GET', '/events/sample', undefined, filters)).items;
	const fingerprint = JSON.stringify(filters);
	if (
		state.checkpoint === settings.checkpoint &&
		state.filters !== undefined &&
		state.filters !== fingerprint
	)
		throw new SafeMessageError('Filters changed. Choose a new checkpoint label to start from now.');
	if (!state.cursor || state.checkpoint !== settings.checkpoint) {
		const page = await client.json<Feed>('GET', '/events', undefined, { ...filters, start: 'now' });
		if (!page.nextCursor)
			throw new SafeMessageError('The Library did not return an event checkpoint.');
		Object.assign(state, {
			cursor: page.nextCursor,
			filters: fingerprint,
			checkpoint: settings.checkpoint,
		});
		return [];
	}
	const stop = Date.now() + Math.max(0, budgetMs - 5000);
	const events: IDataObject[] = [];
	let cursor = String(state.cursor);
	// Continue the remaining backlog next tick; every page stays behind the durable cursor.
	for (let pages = 0; pages < 10; pages++) {
		const page = await client.json<Feed>('GET', '/events', undefined, {
			...filters,
			cursor,
			limit: 100,
		});
		if (!page.nextCursor || page.items.length > 100 || (page.hasMore && page.nextCursor === cursor))
			throw new SafeMessageError('The Library returned an invalid event page.');
		events.push(...page.items);
		cursor = page.nextCursor;
		if (!page.hasMore || Date.now() >= stop) break;
	}
	// The host stages node static data and persists it when it hands off this poll.
	state.cursor = cursor;
	return events;
}
