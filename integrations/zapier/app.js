const { createHash } = require('node:crypto');
const dns = require('node:dns/promises');
const { BlockList, isIP } = require('node:net');
const locales = require('./locales.json');
const createAuthentication = require('./authentication');
const createConnect = require('./connect');

// ponytail: Zapier holds files in memory; 100 MiB keeps an upload or rendition inside a task's
// memory. Raise only with Zapier's documented limits, and stream if they allow it.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Connect's latest feed is bounded to the newest 1000 events across ten pages of 100.
const MAX_EVENT_PAGES = 10;
const VARIANTS = ['preview', 'display', 'thumbnail', 'original'];
const SIGNATURES = [
  ['image/jpeg', 'jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', 'png', (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  ['application/pdf', 'pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['video/mp4', 'mp4', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'],
];
// Addresses a source may never resolve to: loopback, private, link-local (cloud metadata), CGNAT,
// unspecified, multicast and their IPv6 forms.
const PRIVATE = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]])
  PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]])
  PRIVATE.addSubnet(net, prefix, 'ipv6');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const startOfUtcDay = () => new Date(new Date().toISOString().slice(0, 10)).toISOString();

module.exports = function createApp(locale = 'en') {
  if (!Object.hasOwn(locales, locale)) throw new Error('Unsupported locale');
  const text = locales[locale];
  const { api, uuid } = createConnect(text);
  const fail = (z, key, code = 'Failed', status = 400) => {
    throw new z.errors.Error(text[key], code, status);
  };

  async function hydrateRendition(z, bundle) {
    const assetId = uuid(z, bundle.inputData.assetId);
    const variant = bundle.inputData.variant;
    if (!VARIANTS.includes(variant)) fail(z, 'invalidVariant');
    // Runs when a later step uses the file, with the connection's current token, so a revoked or
    // narrowed grant is enforced at that moment rather than when the trigger fired.
    const response = await api(z, bundle, 'GET', `assets/${assetId}/rendition`, {
      raw: true,
      params: { variant },
      timeout: 120000,
    });
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FILE_BYTES)
      fail(z, 'tooLarge', 'TooLarge', 413);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    const extension = SIGNATURES.find(([type]) => type === contentType)?.[1] ?? contentType.split('/')[1];
    return z.stashFile(
      response,
      length,
      `${assetId}${/^[a-z0-9]{1,8}$/.test(extension ?? '') ? '.' + extension : ''}`,
      contentType || undefined,
    );
  }
  const file = (z, assetId, variant) => z.dehydrateFile(hydrateRendition, { assetId, variant });
  const variantOf = (z, bundle) => {
    const variant = bundle.inputData.variant || 'preview';
    if (!VARIANTS.includes(variant)) fail(z, 'invalidVariant');
    return variant;
  };

  const eventRecord = (z, item, variant) => {
    if (
      !item ||
      typeof item.deliveryId !== 'string' ||
      typeof item.occurredAt !== 'string' ||
      item.subject?.kind !== 'asset'
    )
      fail(z, 'failed', 'Failed', 502);
    const assetId = uuid(z, item.subject.id);
    return {
      id: uuid(z, item.deliveryId),
      event: item.event,
      occurredAt: item.occurredAt,
      assetId,
      albumId: typeof item.detail?.albumId === 'string' ? item.detail.albumId : null,
      format: typeof item.detail?.format === 'string' ? item.detail.format : null,
      file: file(z, assetId, variant),
    };
  };
  const pollEvents = (type) => async (z, bundle) => {
    const params = { type };
    if (bundle.inputData.albumId) params.albumId = uuid(z, bundle.inputData.albumId);
    const variant = variantOf(z, bundle);
    if (bundle.meta?.isLoadingSample) {
      const data = await api(z, bundle, 'GET', 'events/sample', { params });
      return (Array.isArray(data.items) ? data.items : []).map((item) => eventRecord(z, item, variant));
    }
    // Bounded polling: each poll rescans at most the newest 1000 matching events, newest first.
    // Zapier deduplicates on the stable delivery ID. A burst larger than 1000 between two polls
    // omits the oldest events of that burst; this is not lossless synchronization.
    const records = new Map();
    let cursor;
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const data = await api(z, bundle, 'GET', 'events/latest', {
        params: cursor ? { ...params, cursor } : params,
      });
      if (!Array.isArray(data.items)) fail(z, 'failed', 'Failed', 502);
      for (const item of data.items) {
        const record = eventRecord(z, item, variant);
        if (record.event === type && !records.has(record.id)) records.set(record.id, record);
      }
      if (!data.hasMore) break;
      if (typeof data.nextCursor !== 'string' || !data.nextCursor) fail(z, 'failed', 'Failed', 502);
      cursor = data.nextCursor;
    }
    return [...records.values()];
  };

  const assetRecord = (z, asset, variant) => ({
    id: uuid(z, asset.id),
    type: asset.type,
    description: asset.description ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    duration: asset.duration ?? null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    file: file(z, asset.id, variant),
  });
  const albumRecord = (album) => ({
    id: album.id,
    name: album.name,
    workspace: album.workspace,
    canRead: album.canRead,
    canWrite: album.canWrite,
  });
  const albums = async (z, bundle) => {
    const data = await api(z, bundle, 'GET', 'albums');
    return (Array.isArray(data.items) ? data.items : []).map(albumRecord);
  };

  // Stable Source IDs make Zapier replays, retries and concurrent runs idempotent: the same
  // source always maps to the same Connect request ID, which the Library deduplicates per grant.
  const requestId = (z, kind, scope, sourceId) => {
    if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 1000) fail(z, 'invalidSourceId');
    return 'zapier-' + kind + '-' + sha256([kind, scope, sourceId.trim()].join('\0'));
  };

  function publicHttps(z, value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      fail(z, 'invalidSource', 'InvalidSource');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      isIP(host) ||
      !host.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa)\.?$/.test(host)
    )
      fail(z, 'invalidSource', 'InvalidSource');
    return url;
  }
  // ponytail: checks the resolved addresses before connecting; fetch resolves again, so a DNS
  // rebinding race remains. Pin the checked address with a custom agent if that ever matters.
  async function resolvable(z, url) {
    let addresses;
    try {
      addresses = await dns.lookup(url.hostname, { all: true });
    } catch {
      fail(z, 'sourceFailed', 'SourceFailed', 502);
    }
    if (!addresses.length || addresses.some(({ address, family }) => PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4')))
      fail(z, 'invalidSource', 'InvalidSource');
    return url;
  }
  // Fetches the file a previous step supplied. Uses plain fetch, never z.request, so no Library
  // credential can be attached; only public HTTPS, at most three re-validated redirects, a deadline
  // and a byte ceiling enforced while streaming.
  async function fetchSource(z, value, limit) {
    let url = publicHttps(z, value);
    for (let hop = 0; hop <= 3; hop++) {
      await resolvable(z, url);
      let response;
      try {
        response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(60000),
          headers: { Accept: '*/*' },
        });
      } catch {
        fail(z, 'sourceFailed', 'SourceFailed', 502);
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = publicHttps(z, new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        fail(z, 'sourceFailed', 'SourceFailed', 502);
      }
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body.cancel();
        fail(z, 'tooLarge', 'TooLarge', 413);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) fail(z, 'tooLarge', 'TooLarge', 413);
        chunks.push(chunk);
      }
      const modified = new Date(response.headers.get('last-modified') ?? '');
      return {
        bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        name: safeDecode(url.pathname.split('/').at(-1) ?? ''),
        modifiedAt: Number.isNaN(modified.getTime()) ? null : modified.toISOString(),
      };
    }
    fail(z, 'sourceFailed', 'SourceFailed', 502);
  }
  const uploadName = (requested, fallback, extension) => {
    const clean = (value) =>
      // eslint-disable-next-line no-control-regex
      String(value ?? '').replace(/[/\\\u0000-\u001f]/g, '').trim().slice(0, 200);
    const name = clean(requested) || clean(fallback) || 'zapier';
    const base = name.replace(/\.[^.]*$/, '') || 'zapier';
    return `${base}.${extension}`;
  };

  async function uploadFile(z, bundle) {
    const input = bundle.inputData;
    const albumId = uuid(z, input.albumId);
    const id = requestId(z, 'upload', albumId, input.sourceId);
    const capabilities = await api(z, bundle, 'GET', 'capabilities');
    const album = (capabilities.albums ?? []).find((item) => item.id === albumId);
    if (!album?.canWrite || !['photo', 'design'].includes(album.workspace)) fail(z, 'forbidden', 'Forbidden', 403);
    const limit = Math.min(Number(capabilities.limits?.maxUploadBytes) || 0, MAX_FILE_BYTES);
    const appendLimit = Number(capabilities.limits?.maxAppendBytes) || 0;
    if (limit < 1 || appendLimit < 1) fail(z, 'forbidden', 'Forbidden', 403);
    const source = await fetchSource(z, input.file, limit);
    // The Library checks the type again; sniffing keeps a mislabelled source from being sent at all.
    const signature = SIGNATURES.find(([, , matches]) => matches(source.bytes));
    if (!signature || !capabilities.supportedTypes?.upload?.[album.workspace]?.includes(signature[0]))
      fail(z, 'unsupportedType', 'UnsupportedType', 415);
    const [contentType, extension] = signature;
    const checksum = sha256(source.bytes);
    // Every start field is deterministic for one source, so a replay sends an identical payload.
    // ponytail: without a capture date or Last-Modified, the date is the current UTC day; a retry
    // that crosses midnight is refused as a reused Source ID rather than duplicated.
    let capturedAt = source.modifiedAt ?? startOfUtcDay();
    if (input.capturedAt) {
      const date = new Date(input.capturedAt);
      if (Number.isNaN(date.getTime())) fail(z, 'invalidDate');
      capturedAt = date.toISOString();
    }
    let state = await api(z, bundle, 'POST', 'uploads', {
      json: {
        requestId: id,
        albumId,
        workspace: album.workspace,
        filename: uploadName(input.filename, source.name, extension),
        size: source.bytes.length,
        sha256: checksum,
        contentType,
        fileCreatedAt: capturedAt,
        fileModifiedAt: capturedAt,
      },
    });
    const uploadId = uuid(z, state.id);
    const maxSteps = Math.ceil(source.bytes.length / appendLimit) + 5;
    for (let step = 0; step < maxSteps; step++) {
      if (state.receipt) return receiptRecord(z, state.receipt, albumId, input.sourceId);
      if (state.state === 'rejected' || state.state === 'cancelled') fail(z, 'uploadRejected', 'UploadRejected', 422);
      if (state.state === 'verified' || state.state === 'published') {
        const receipt = await api(z, bundle, 'POST', `uploads/${uploadId}/commit`, {
          json: { requestId: id, sha256: checksum },
        });
        return receiptRecord(z, receipt, albumId, input.sourceId);
      }
      if (state.state !== 'receiving') throw new z.errors.ThrottledError(text.busy, 15);
      const offset = state.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.bytes.length)
        fail(z, 'failed', 'Failed', 502);
      const chunk = source.bytes.subarray(offset, offset + appendLimit);
      // A 409 means another run moved the durable offset; read it and resume from there.
      state =
        (await api(z, bundle, 'PATCH', `uploads/${uploadId}`, {
          body: chunk,
          conflict: true,
          timeout: 120000,
          headers: {
            'Content-Type': 'application/partial-upload',
            'Upload-Draft-Interop-Version': '9',
            'Upload-Offset': String(offset),
            'Upload-Complete': offset + chunk.length === source.bytes.length ? '?1' : '?0',
          },
        })) ?? (await api(z, bundle, 'GET', `uploads/${uploadId}`));
    }
    throw new z.errors.ThrottledError(text.busy, 15);
  }
  const receiptRecord = (z, receipt, albumId, sourceId) => ({
    id: uuid(z, receipt.assetId),
    assetId: receipt.assetId,
    status: receipt.status,
    sha256: receipt.sha256,
    albumId,
    sourceId,
  });

  const albumField = (key, required, writable) => ({
    key,
    label: text.albumLabel,
    helpText: writable ? text.writableAlbumHelp : text.albumHelp,
    required,
    dynamic: writable ? 'writable_album_list.id.name' : 'album_list.id.name',
  });
  const variantField = {
    key: 'variant',
    label: text.variantLabel,
    helpText: text.variantHelp,
    choices: VARIANTS,
    default: 'preview',
    required: false,
  };
  const sourceIdField = {
    key: 'sourceId',
    label: text.sourceIdLabel,
    helpText: text.sourceIdHelp,
    required: true,
  };
  const assetSample = {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'IMAGE',
    description: null,
    width: 4032,
    height: 3024,
    duration: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
    file: 'https://zapier.com/sample-file.jpg',
  };
  const albumSample = {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Holiday',
    workspace: 'photo',
    canRead: true,
    canWrite: true,
  };
  const eventTrigger = (key, type, label, description, albumFilter) => ({
    key,
    noun: text.eventNoun,
    display: { label, description },
    operation: {
      type: 'polling',
      inputFields: [...(albumFilter ? [albumField('albumId', false, false)] : []), variantField],
      perform: pollEvents(type),
      sample: {
        id: '00000000-0000-4000-8000-000000000003',
        event: type,
        occurredAt: '2026-01-01T12:00:00.000Z',
        assetId: assetSample.id,
        albumId: albumFilter ? albumSample.id : null,
        format: type === 'studio.export.completed' ? 'image/jpeg' : null,
        file: assetSample.file,
      },
    },
  });
  const albumList = (key, writable) => ({
    key,
    noun: text.albumNoun,
    display: { label: text.albumListLabel, description: text.albumListDescription, hidden: true },
    operation: {
      perform: async (z, bundle) =>
        (await albums(z, bundle)).filter((album) => (writable ? album.canWrite : album.canRead)),
      sample: albumSample,
    },
  });
  const list = (z, value, max, check) => {
    const items = (Array.isArray(value) ? value : [value]).filter((item) => item !== undefined && item !== '');
    if (items.length < 1 || items.length > max) fail(z, 'invalidList');
    return items.map(check);
  };

  return {
    version: require('./package.json').version,
    platformVersion: require('zapier-platform-core').version,
    authentication: createAuthentication(locale),
    flags: { cleanInputData: false },
    hydrators: { rendition: hydrateRendition },
    triggers: {
      asset_ready: eventTrigger('asset_ready', 'asset.ready', text.assetReadyLabel, text.assetReadyDescription, false),
      album_asset_added: eventTrigger(
        'album_asset_added',
        'album.asset.added',
        text.albumAssetAddedLabel,
        text.albumAssetAddedDescription,
        true,
      ),
      studio_export_completed: eventTrigger(
        'studio_export_completed',
        'studio.export.completed',
        text.studioExportLabel,
        text.studioExportDescription,
        false,
      ),
      album_list: albumList('album_list', false),
      writable_album_list: albumList('writable_album_list', true),
    },
    searches: {
      find_asset: {
        key: 'find_asset',
        noun: text.assetNoun,
        display: { label: text.findAssetLabel, description: text.findAssetDescription },
        operation: {
          inputFields: [
            { key: 'assetId', label: text.assetIdLabel, helpText: text.assetIdHelp, required: false },
            { key: 'q', label: text.queryLabel, helpText: text.queryHelp, required: false },
            albumField('albumId', false, false),
            { key: 'type', label: text.typeLabel, choices: ['IMAGE', 'VIDEO'], required: false },
            variantField,
          ],
          perform: async (z, bundle) => {
            const input = bundle.inputData;
            const variant = variantOf(z, bundle);
            if (input.assetId) {
              const assetId = uuid(z, input.assetId);
              const asset = await api(z, bundle, 'GET', `assets/${assetId}`, { missing: true });
              return asset ? [assetRecord(z, asset, variant)] : [];
            }
            const params = { page: 1, size: 25 };
            if (input.q) params.q = String(input.q).slice(0, 200);
            if (input.albumId) params.albumId = uuid(z, input.albumId);
            if (input.type) params.type = input.type === 'VIDEO' ? 'VIDEO' : 'IMAGE';
            const data = await api(z, bundle, 'GET', 'assets', { params });
            return (Array.isArray(data.items) ? data.items : []).map((asset) => assetRecord(z, asset, variant));
          },
          sample: assetSample,
        },
      },
      find_album: {
        key: 'find_album',
        noun: text.albumNoun,
        display: { label: text.findAlbumLabel, description: text.findAlbumDescription },
        operation: {
          inputFields: [{ key: 'name', label: text.albumNameLabel, required: true }],
          perform: async (z, bundle) => {
            const name = String(bundle.inputData.name ?? '').trim().toLocaleLowerCase();
            return (await albums(z, bundle)).filter((album) => album.name.trim().toLocaleLowerCase() === name);
          },
          sample: albumSample,
        },
      },
    },
    creates: {
      create_album: {
        key: 'create_album',
        noun: text.albumNoun,
        display: { label: text.createAlbumLabel, description: text.createAlbumDescription },
        operation: {
          inputFields: [
            { key: 'name', label: text.albumNameLabel, required: true },
            {
              key: 'workspace',
              label: text.workspaceLabel,
              helpText: text.workspaceHelp,
              choices: ['photo', 'design'],
              default: 'photo',
              required: true,
            },
            sourceIdField,
          ],
          perform: async (z, bundle) => {
            const input = bundle.inputData;
            const name = String(input.name ?? '').trim();
            if (!name || name.length > 500) fail(z, 'invalidName');
            const workspace = input.workspace === 'design' ? 'design' : 'photo';
            return albumRecord(
              await api(z, bundle, 'POST', 'albums', {
                json: { requestId: requestId(z, 'album', workspace, input.sourceId), name, workspace },
              }),
            );
          },
          sample: albumSample,
        },
      },
      add_to_album: {
        key: 'add_to_album',
        noun: text.albumNoun,
        display: { label: text.addToAlbumLabel, description: text.addToAlbumDescription },
        operation: {
          inputFields: [
            albumField('albumId', true, true),
            { key: 'assetIds', label: text.assetIdsLabel, helpText: text.assetIdsHelp, list: true, required: true },
          ],
          perform: async (z, bundle) => {
            const albumId = uuid(z, bundle.inputData.albumId);
            const assetIds = list(z, bundle.inputData.assetIds, 100, (value) => uuid(z, value));
            const results = await api(z, bundle, 'POST', `albums/${albumId}/assets`, { json: { assetIds } });
            if (!Array.isArray(results)) fail(z, 'failed', 'Failed', 502);
            return {
              id: albumId,
              albumId,
              added: results.filter((result) => result.success).map((result) => result.id),
              alreadyPresent: results.filter((result) => result.error === 'duplicate').map((result) => result.id),
              failed: results
                .filter((result) => !result.success && result.error !== 'duplicate')
                .map((result) => result.id),
            };
          },
          sample: { id: albumSample.id, albumId: albumSample.id, added: [assetSample.id], alreadyPresent: [], failed: [] },
        },
      },
      add_tags: {
        key: 'add_tags',
        noun: text.assetNoun,
        display: { label: text.addTagsLabel, description: text.addTagsDescription },
        operation: {
          inputFields: [
            { key: 'assetId', label: text.assetIdLabel, required: true },
            { key: 'tags', label: text.tagsLabel, helpText: text.tagsHelp, list: true, required: true },
          ],
          perform: async (z, bundle) => {
            const assetId = uuid(z, bundle.inputData.assetId);
            const tags = list(z, bundle.inputData.tags, 20, (value) => {
              const tag = String(value).trim();
              if (!tag || tag.length > 100 || tag.includes('/')) fail(z, 'invalidTag');
              return tag;
            });
            const data = await api(z, bundle, 'POST', `assets/${assetId}/tags`, { json: { tags } });
            return { id: assetId, assetId, tagIds: Array.isArray(data.tagIds) ? data.tagIds : [] };
          },
          sample: { id: assetSample.id, assetId: assetSample.id, tagIds: ['00000000-0000-4000-8000-000000000004'] },
        },
      },
      upload_file: {
        key: 'upload_file',
        noun: text.fileNoun,
        display: { label: text.uploadLabel, description: text.uploadDescription },
        operation: {
          inputFields: [
            albumField('albumId', true, true),
            { key: 'file', label: text.fileLabel, helpText: text.fileHelp, type: 'file', required: true },
            sourceIdField,
            { key: 'filename', label: text.filenameLabel, helpText: text.filenameHelp, required: false },
            { key: 'capturedAt', label: text.capturedAtLabel, helpText: text.capturedAtHelp, type: 'datetime', required: false },
          ],
          perform: uploadFile,
          sample: {
            id: assetSample.id,
            assetId: assetSample.id,
            status: 'created',
            sha256: 'a'.repeat(64),
            albumId: albumSample.id,
            sourceId: 'example-source-1',
          },
        },
      },
    },
    searchOrCreates: {
      find_album: {
        key: 'find_album',
        display: { label: text.findOrCreateAlbumLabel, description: text.findOrCreateAlbumDescription },
        search: 'find_album',
        create: 'create_album',
      },
    },
  };
};
