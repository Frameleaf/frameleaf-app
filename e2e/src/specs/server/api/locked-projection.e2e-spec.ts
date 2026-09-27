import { LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type Read = { name: string; method?: 'get' | 'post'; path: string; query?: object; body?: object };

/** Every read, and what it answered; a read that refuses (4xx) is not a leak either. */
const readAll = async (reads: Read[], headers: Record<string, string>) => {
  const answers: { name: string; status: number; text: string }[] = [];
  for (const { name, method = 'get', path, query, body } of reads) {
    const call = request(app)[method](path).set(headers);
    const { status, text } = await (query ? call.query(query) : call).send(body);
    expect(status, `${name} answered ${status}: ${text}`).toBeLessThan(500);
    answers.push({ name, status, text });
  }
  return answers;
};

const expectNoTrace = (answers: { name: string; text: string }[], secrets: string[]) => {
  for (const { name, text } of answers) {
    for (const secret of secrets) {
      expect(text.includes(secret), `${name} mentions ${secret}`).toBe(false);
    }
  }
};

const oneItemReads = (id: string): Read[] => [
  { name: `asset ${id}`, path: `/assets/${id}` },
  { name: `thumbnail ${id}`, path: `/assets/${id}/thumbnail` },
  { name: `original ${id}`, path: `/assets/${id}/original` },
  { name: `metadata ${id}`, path: `/assets/${id}/metadata` },
  { name: `download ${id}`, method: 'post', path: '/download/info', body: { assetIds: [id] } },
];

const lock = (token: string) => request(app).post('/auth/session/lock').set(bearer(token)).expect(204);

/**
 * FL-34, over the API: Locked media reaches only its owner, and only in a PIN-unlocked session. A
 * locked session also loses what the owner's Locked rules hide. Every projection that could name,
 * count or show an item is read — timeline, search, counts, facets, memories, people, tags, folders,
 * the map, albums, stacks, duplicates, Trash, downloads — as the owner locked, the owner unlocked,
 * a partner, an album member, an elevated administrator and a shared link.
 *
 * FL-195 (owner decision, September 27, 2026): unlocked, the owner's marks, detections and rule
 * matches behave like any other item in every one of those reads; items from the old Locked folder
 * stay in the Locked view. Locked, they keep their places and associations but show nowhere.
 */
describe('Locked projection over the API (FL-34, FL-195)', () => {
  const pinCode = '975310';
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let partner: LoginResponseDto;
  let member: LoginResponseDto;
  let plain: { id: string };
  let locked: { id: string };
  let detected: { id: string };
  let legacy: { id: string };
  let ruleMatch: { id: string };
  let albumId: string;
  let memoryId: string;
  let lockedOnlyMemoryId: string;
  let personId: string;
  let tripTagId: string;
  let projectId: string;
  let sharedKey: string;
  let folderPath: string;
  const hiddenTag = 'FL-34 hidden rule';
  // Owner decision, September 27, 2026: while locked, a tag carried only by hidden items is hidden too.
  const lockedOnlyTag = 'FL-34 locked only';
  const besideRuleTag = 'FL-34 beside rule';
  // ...and one visible item brings it back, counted without the hidden one.
  const mixedTag = 'FL-34 on both';
  const tagIds: Record<string, string> = {};
  const tripTag = 'FL-195 trip';

  const ownerReads = (): Read[] => [
    { name: 'timeline buckets', path: '/timeline/buckets', query: { visibility: 'timeline' } },
    { name: 'timeline bucket', path: '/timeline/bucket', query: { visibility: 'timeline', timeBucket: '2021-06-01' } },
    { name: 'timeline highlights', path: '/timeline/highlights', query: { grouping: 'month' } },
    { name: 'timeline ordered', path: '/timeline/ordered', query: { sort: 'filename', skip: 0, take: 50 } },
    { name: 'search metadata', method: 'post', path: '/search/metadata', body: {} },
    { name: 'search random', method: 'post', path: '/search/random', body: { size: 50 } },
    { name: 'search statistics', method: 'post', path: '/search/statistics', body: {} },
    { name: 'search facets', method: 'post', path: '/search/facets', body: { facets: ['type', 'tags', 'city'] } },
    { name: 'search histogram', method: 'post', path: '/search/histogram', body: {} },
    { name: 'explore', path: '/search/explore' },
    { name: 'places', path: '/search/places', query: { name: 'Paris' } },
    { name: 'cities', path: '/search/cities' },
    { name: 'city counts', path: '/search/cities/counts' },
    { name: 'suggestions', path: '/search/suggestions', query: { type: 'city' } },
    { name: 'map markers', path: '/map/markers' },
    { name: 'map statistics', path: '/map/statistics' },
    { name: 'memories', path: '/memories' },
    { name: 'memory', path: `/memories/${memoryId}` },
    { name: 'memory statistics', path: '/memories/statistics' },
    { name: 'tags', path: '/tags' },
    { name: 'tag statistics', path: '/tags/statistics' },
    { name: 'people', path: '/people' },
    { name: 'albums', path: '/albums' },
    { name: 'album', path: `/albums/${albumId}` },
    { name: 'album statistics', path: '/albums/statistics' },
    { name: 'album map markers', path: `/albums/${albumId}/map-markers` },
    { name: 'album bucket', path: '/timeline/bucket', query: { albumId, timeBucket: '2021-06-01' } },
    { name: 'asset statistics', path: '/assets/statistics' },
    { name: 'stacks', path: '/stacks' },
    { name: 'duplicates', path: '/duplicates' },
    { name: 'folders', path: '/view/folder', query: { path: folderPath } },
    { name: 'folder summary', path: '/view/folder/summary' },
    { name: 'trash summary', path: '/trash/summary' },
    { name: 'trash items', path: '/trash/items' },
    { name: 'download info', method: 'post', path: '/download/info', body: { albumId } },
    { name: 'activities', path: '/activities', query: { albumId } },
  ];

  /** Everything a locked session, or anybody else, must never see. */
  const hiddenIds = () => [locked.id, detected.id, legacy.id, ruleMatch.id];

  const unlock = (token: string) =>
    request(app).post('/auth/session/unlock').set(bearer(token)).send({ pinCode }).expect(204);

  const newAsset = async (name: string) => {
    const asset = await utils.createAsset(owner.accessToken, {
      assetData: { filename: `${name}.png` },
      fileCreatedAt: '2021-06-15T10:00:00.000Z',
      fileModifiedAt: '2021-06-15T10:00:00.000Z',
    });
    await request(app)
      .put(`/assets/${asset.id}`)
      .set(bearer(owner.accessToken))
      .send({ latitude: 48.8566, longitude: 2.3522, dateTimeOriginal: '2021-06-15T10:00:00.000Z' })
      .expect(200);
    return asset;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
    partner = await utils.userSetup(admin.accessToken, createUserDto.user2);
    member = await utils.userSetup(admin.accessToken, createUserDto.user3);

    plain = await newAsset('plain-photo');
    locked = await newAsset('locked-secret');
    detected = await newAsset('detected-secret');
    legacy = await newAsset('legacy-secret');
    ruleMatch = await newAsset('rule-secret');
    const { body: plainInfo } = await request(app).get(`/assets/${plain.id}`).set(bearer(owner.accessToken));
    folderPath = plainInfo.originalPath.replace(/\/[^/]+$/, '');

    const [tag, trip] = await utils.upsertTags(owner.accessToken, [hiddenTag, tripTag]);
    await utils.tagAssets(owner.accessToken, tag.id, [ruleMatch.id]);
    for (const [name, assetIds] of [
      [lockedOnlyTag, [locked.id]],
      [besideRuleTag, [ruleMatch.id]],
      [mixedTag, [locked.id, plain.id]],
    ] as const) {
      const [created] = await utils.upsertTags(owner.accessToken, [name]);
      await utils.tagAssets(owner.accessToken, created.id, [...assetIds]);
      tagIds[name] = created.id;
    }
    tagIds[hiddenTag] = tag.id;
    tripTagId = trip.id;
    // only hidden items carry this tag, so a locked session hides the tag itself (FL-46)
    await utils.tagAssets(owner.accessToken, trip.id, [locked.id, detected.id, ruleMatch.id]);

    const person = await utils.createPerson(owner.accessToken, { name: 'FL-195 Friend' });
    personId = person.id;
    for (const asset of [plain, locked, detected, ruleMatch]) {
      await utils.createFace({ assetId: asset.id, personGroupId: person.id });
    }

    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'Holiday',
      assetIds: [plain.id, locked.id, detected.id, ruleMatch.id],
      albumUsers: [{ userId: member.userId, role: 'viewer' as never }],
    });
    albumId = album.id;
    const { body: memory } = await request(app)
      .post('/memories')
      .set(bearer(owner.accessToken))
      .send({
        type: 'on_this_day',
        data: { year: 2021 },
        memoryAt: '2021-06-15T00:00:00.000Z',
        assetIds: [plain.id, locked.id, detected.id, ruleMatch.id],
      })
      .expect(201);
    memoryId = memory.id;
    const { body: lockedOnlyMemory } = await request(app)
      .post('/memories')
      .set(bearer(owner.accessToken))
      .send({
        type: 'on_this_day',
        data: { year: 2020 },
        memoryAt: '2020-06-15T00:00:00.000Z',
        assetIds: [locked.id, detected.id],
      })
      .expect(201);
    lockedOnlyMemoryId = lockedOnlyMemory.id;
    const link = await utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Album, albumId });
    sharedKey = link.key;

    await utils.createPartner(owner.accessToken, partner.userId);
    await request(app)
      .put(`/partners/${owner.userId}`)
      .set(bearer(partner.accessToken))
      .send({ inTimeline: true })
      .expect(200);

    for (const user of [owner, admin]) {
      await request(app).post('/auth/pin-code').set(bearer(user.accessToken)).send({ pinCode }).expect(204);
    }
    await unlock(owner.accessToken);
    await request(app)
      .put('/users/me/preferences')
      .set(bearer(owner.accessToken))
      .send({ privacy: { suppression: { tagIds: [tag.id] } } })
      .expect(200);
    await request(app)
      .post('/assets/lock')
      .set(bearer(owner.accessToken))
      .send({ ids: [locked.id] })
      .expect(204);
    // a detection and an item from the old Locked folder, as the detector and the upgrade write them
    await utils.setAssetLock(detected.id, 'detected');
    await utils.setAssetLock(legacy.id, 'immich-locked-folder');

    // FL-195: an unlocked owner places a mark and a detection in a Studio project like any other item
    const { body: project } = await request(app)
      .post('/studio/projects')
      .set(bearer(owner.accessToken))
      .send({
        name: 'FL-195 cut',
        clientId: 'fl-195-editor',
        envelope: {
          schemaVersion: 1,
          engine: 'freecut',
          engineRevision: 'fl-195',
          graph: {
            id: 'seq-main',
            tracks: [
              {
                id: 't-video',
                kind: 'video',
                clips: [{ assetId: plain.id }, { assetId: locked.id }, { assetId: detected.id }],
              },
            ],
          },
        },
      });
    expect(project.id, JSON.stringify(project)).toBeDefined();
    projectId = project.id;
  });

  it("lists the owner's locks and Locked-rule matches in the Locked view of an unlocked session", async () => {
    await unlock(owner.accessToken);
    const { body: buckets } = await request(app)
      .get('/timeline/buckets')
      .query({ visibility: 'locked' })
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(buckets).toEqual([{ timeBucket: '2021-06-01', count: 4 }]);
    const { body: bucket } = await request(app)
      .get('/timeline/bucket')
      .query({ visibility: 'locked', timeBucket: '2021-06-01' })
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(new Set(bucket.id)).toEqual(new Set([locked.id, detected.id, legacy.id, ruleMatch.id]));

    // the control for the sweep below: an unlocked session does find both through the same reads
    const answers = await readAll(ownerReads(), bearer(owner.accessToken));
    const search = answers.find((answer) => answer.name === 'search metadata')!.text;
    expect(search).toContain(locked.id);
    expect(search).toContain(ruleMatch.id);
    const tags = answers.find((answer) => answer.name === 'tags')!.text;
    for (const name of [hiddenTag, lockedOnlyTag, besideRuleTag, mixedTag]) {
      expect(tags).toContain(name);
    }
  });

  it("finds the owner's marks, detections and rule matches everywhere once unlocked, like any other item (FL-195)", async () => {
    await unlock(owner.accessToken);
    const revealed = [plain.id, locked.id, detected.id, ruleMatch.id];
    const timeline = { visibility: 'timeline' };
    const reads: Read[] = [
      ...ownerReads(),
      // what the web sends: the library, a person, a tag and the search page's structured filter
      { name: 'person buckets', path: '/timeline/buckets', query: { ...timeline, personId } },
      { name: 'tag buckets', path: '/timeline/buckets', query: { ...timeline, tagId: tripTagId } },
      {
        name: 'album timeline bucket',
        path: '/timeline/bucket',
        query: { ...timeline, albumId, timeBucket: '2021-06-01' },
      },
      { name: 'search timeline', method: 'post', path: '/search/metadata', body: timeline },
      {
        name: 'search filter',
        method: 'post',
        path: '/search/metadata',
        body: { filter: { visibility: { eq: 'timeline' } } },
      },
      {
        name: 'search tag filter',
        method: 'post',
        path: '/search/metadata',
        body: { filter: { tagIds: { any: [tripTagId] } } },
      },
      { name: 'search random timeline', method: 'post', path: '/search/random', body: { ...timeline, size: 50 } },
      { name: 'search statistics timeline', method: 'post', path: '/search/statistics', body: timeline },
      {
        name: 'search statistics filter',
        method: 'post',
        path: '/search/statistics',
        body: { filter: { visibility: { eq: 'timeline' } } },
      },
      { name: 'search histogram timeline', method: 'post', path: '/search/histogram', body: timeline },
      { name: 'person statistics', path: `/people/${personId}/statistics` },
      { name: 'timeline asset statistics', path: '/assets/statistics', query: timeline },
      { name: 'map statistics', path: '/map/statistics' },
      { name: 'studio project', path: `/studio/projects/${projectId}` },
    ];
    const answers = await readAll(reads, bearer(owner.accessToken));
    const answer = (name: string) => answers.find((read) => read.name === name)!;
    const json = (name: string) => JSON.parse(answer(name).text);

    // every read that lists items lists all four, and never the item from the old Locked folder
    for (const name of [
      'timeline bucket',
      'album timeline bucket',
      'search metadata',
      'search timeline',
      'search filter',
      'search random timeline',
      'map markers',
      'memory',
      'album bucket',
      'download info',
    ]) {
      for (const id of revealed) {
        expect(answer(name).text, `${name} finds ${id}`).toContain(id);
      }
      if (name !== 'search metadata') {
        expect(answer(name).text, `${name} keeps the old Locked folder item in Locked`).not.toContain(legacy.id);
      }
    }

    // each item's own folder lists it (originals sit in per-asset folders); the old-folder item's does not
    for (const { id } of [locked, detected, ruleMatch, legacy]) {
      const { body: info } = await request(app).get(`/assets/${id}`).set(bearer(owner.accessToken)).expect(200);
      const { text } = await request(app)
        .get('/view/folder')
        .query({ path: info.originalPath.replace(/\/[^/]+$/, '') })
        .set(bearer(owner.accessToken))
        .expect(200);
      if (id === legacy.id) {
        expect(text, 'the folder keeps the old Locked folder item in Locked').not.toContain(id);
      } else {
        expect(text, `folder of ${id}`).toContain(id);
      }
    }

    // and every count counts them
    const month = [{ timeBucket: '2021-06-01', count: 4 }];
    expect(json('timeline buckets')).toEqual(month);
    expect(json('person buckets')).toEqual(month);
    expect(json('tag buckets')).toEqual([{ timeBucket: '2021-06-01', count: 3 }]);
    for (const id of [locked.id, detected.id, ruleMatch.id]) {
      expect(answer('search tag filter').text, `tag filter finds ${id}`).toContain(id);
    }
    expect(json('search statistics timeline').total).toBe(4);
    expect(json('search statistics filter').total).toBe(4);
    expect(json('asset statistics').total).toBe(4);
    expect(json('timeline asset statistics').total).toBe(4);
    expect(json('album').assetCount).toBe(4);
    expect(json('memory').assets).toHaveLength(4);
    expect(json('person statistics').assets).toBe(4);
    const people = json('people');
    expect(people.people.find((row: { id: string }) => row.id === personId)?.assetCount).toBe(4);
    const tagStats = json('tag statistics');
    expect(tagStats.find((row: { id: string }) => row.id === tripTagId)?.count).toBe(3);
    expect(json('search histogram timeline').total).toBe(4);
    expect(json('memories').map((memory: { id: string }) => memory.id)).toContain(lockedOnlyMemoryId);

    // Studio: the project holds the mark and the detection and every source resolves
    const project = json('studio project');
    expect(project.resources, JSON.stringify(project)).toEqual(
      expect.objectContaining({ complete: true, refusedCount: 0 }),
    );
    // a poster shows whatever the session, so a revealed lock never becomes one
    await request(app)
      .put(`/studio/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .send({ thumbnailAssetId: locked.id })
      .expect(400);
    await request(app)
      .put(`/studio/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .send({ thumbnailAssetId: plain.id })
      .expect(200);
  });

  it('leaves no trace of a lock or a rule match in any projection of a locked session', async () => {
    await lock(owner.accessToken);
    const answers = await readAll(
      [
        ...ownerReads(),
        {
          name: 'search filter',
          method: 'post',
          path: '/search/metadata',
          body: { filter: { visibility: { eq: 'timeline' } } },
        },
        { name: 'person statistics', path: `/people/${personId}/statistics` },
        { name: 'locked-only memory', path: `/memories/${lockedOnlyMemoryId}` },
      ],
      bearer(owner.accessToken),
    );
    expectNoTrace(answers, [
      ...hiddenIds(),
      'locked-secret',
      'detected-secret',
      'legacy-secret',
      'rule-secret',
      hiddenTag,
      lockedOnlyMemoryId,
      tripTag,
      tripTagId,
      lockedOnlyTag,
      besideRuleTag,
      tagIds[hiddenTag],
      tagIds[lockedOnlyTag],
      tagIds[besideRuleTag],
    ]);

    const count = (name: string) => JSON.parse(answers.find((answer) => answer.name === name)!.text);
    expect(count('search statistics').total).toBe(1);
    expect(count('asset statistics').total).toBe(1);
    expect(count('album').assetCount).toBe(1);
    expect(count('timeline buckets')).toEqual([{ timeBucket: '2021-06-01', count: 1 }]);
    expect(count('memory').assets).toHaveLength(1);
    expect(count('person statistics').assets).toBe(1);
    // FL-195: the project keeps its references; while locked they resolve like missing media
    const { body: project } = await request(app)
      .get(`/studio/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(project.resources).toEqual(expect.objectContaining({ complete: false, refusedCount: 2 }));

    for (const { name, status } of await readAll(
      [...oneItemReads(locked.id), ...oneItemReads(detected.id), ...oneItemReads(ruleMatch.id)],
      bearer(owner.accessToken),
    )) {
      if (!name.startsWith('download')) {
        expect(status, name).toBeGreaterThanOrEqual(400);
      }
    }
    const { status } = await request(app)
      .get('/timeline/buckets')
      .query({ visibility: 'locked' })
      .set(bearer(owner.accessToken));
    expect(status).toBe(401);
  });

  // Owner decision, September 27, 2026: the tag list, tree, filters, facets and counts of a locked
  // session leave out a tag carried only by hidden items, and count a mixed tag's visible items only.
  it('hides a tag carried only by hidden items from every tag read of a locked session', async () => {
    await lock(owner.accessToken);
    const headers = bearer(owner.accessToken);

    const { body: tags } = await request(app).get('/tags').set(headers).expect(200);
    expect(tags.map(({ value }: { value: string }) => value)).toEqual([mixedTag]);
    const { body: statistics } = await request(app).get('/tags/statistics').set(headers).expect(200);
    expect(statistics).toEqual([{ id: tagIds[mixedTag], count: 1, total: 1 }]);
    const { body: facets } = await request(app)
      .post('/search/facets')
      .set(headers)
      .send({ facets: ['tags'] })
      .expect(200);
    expect(JSON.stringify(facets)).toContain(mixedTag);

    for (const name of [hiddenTag, lockedOnlyTag, besideRuleTag]) {
      const id = tagIds[name];
      await request(app).get(`/tags/${id}`).set(headers).expect(404);
      const filtered = await request(app)
        .get('/timeline/buckets')
        .query({ tagId: id, visibility: 'timeline' })
        .set(headers);
      expect(filtered.status, `timeline filtered by ${name}`).toBeGreaterThanOrEqual(400);
      const search = await request(app)
        .post('/search/metadata')
        .set(headers)
        .send({ tagIds: [id] });
      expect(search.text).not.toContain(locked.id);
      expect(search.text).not.toContain(ruleMatch.id);
    }

    // "Use the existing tag regardless": creating one by a hidden tag's name reuses it, with the tag
    // alone in the answer, and it stays hidden
    for (const name of [hiddenTag, lockedOnlyTag]) {
      const { status, body } = await request(app).post('/tags').set(headers).send({ name });
      expect(status).toBe(201);
      expect(body.id).toBe(tagIds[name]);
      expect(JSON.stringify(body)).not.toContain(locked.id);
      expect(JSON.stringify(body)).not.toContain(ruleMatch.id);
    }
    const { body: after } = await request(app).get('/tags').set(headers).expect(200);
    expect(after.map(({ value }: { value: string }) => value)).toEqual([mixedTag]);

    await unlock(owner.accessToken);
    const { body: unlocked } = await request(app).get('/tags').set(headers).expect(200);
    expect(
      unlocked.map(({ value }: { value: string }) => value).toSorted((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(
      [besideRuleTag, hiddenTag, lockedOnlyTag, mixedTag, tripTag].toSorted((a: string, b: string) =>
        a.localeCompare(b),
      ),
    );
  });

  it('never shows a Locked item to a partner, an album member or a shared link', async () => {
    await unlock(owner.accessToken);
    const partnerAnswers = await readAll(
      [
        { name: 'partner buckets', path: '/timeline/buckets', query: { userId: owner.userId, visibility: 'timeline' } },
        {
          name: 'partner bucket',
          path: '/timeline/bucket',
          query: { userId: owner.userId, visibility: 'timeline', timeBucket: '2021-06-01' },
        },
        { name: 'partner map', path: '/map/markers', query: { withPartners: true } },
        { name: 'partner search', method: 'post', path: '/search/metadata', body: { withPartners: true } },
        {
          name: 'partner search timeline',
          method: 'post',
          path: '/search/metadata',
          body: { visibility: 'timeline', withPartners: true },
        },
        {
          name: 'partner search filter',
          method: 'post',
          path: '/search/metadata',
          body: { filter: { visibility: { eq: 'timeline' } } },
        },
        { name: 'partner statistics', method: 'post', path: '/search/statistics', body: { visibility: 'timeline' } },
        ...oneItemReads(locked.id),
        ...oneItemReads(detected.id),
      ],
      bearer(partner.accessToken),
    );
    expectNoTrace(partnerAnswers, [locked.id, detected.id, legacy.id, 'locked-secret', 'detected-secret']);

    const memberAnswers = await readAll(
      [
        { name: 'member album', path: `/albums/${albumId}` },
        { name: 'member bucket', path: '/timeline/bucket', query: { albumId, timeBucket: '2021-06-01' } },
        { name: 'member album markers', path: `/albums/${albumId}/map-markers` },
        { name: 'member download', method: 'post', path: '/download/info', body: { albumId } },
        {
          name: 'member album search',
          method: 'post',
          path: '/search/metadata',
          body: { filter: { albumIds: { any: [albumId] }, visibility: { eq: 'timeline' } } },
        },
        ...oneItemReads(locked.id),
        ...oneItemReads(detected.id),
      ],
      bearer(member.accessToken),
    );
    expectNoTrace(memberAnswers, [locked.id, detected.id, 'locked-secret', 'detected-secret']);
    expect(JSON.parse(memberAnswers[0].text).assetCount).toBe(2);

    const linkAnswers = await readAll(
      [
        { name: 'link me', path: '/shared-links/me', query: { key: sharedKey } },
        { name: 'link album', path: `/albums/${albumId}`, query: { key: sharedKey } },
        { name: 'link buckets', path: '/timeline/buckets', query: { albumId, key: sharedKey } },
        { name: 'link bucket', path: '/timeline/bucket', query: { albumId, key: sharedKey, timeBucket: '2021-06-01' } },
        { name: 'link download', method: 'post', path: '/download/info', query: { key: sharedKey }, body: { albumId } },
        { name: 'link thumbnail', path: `/assets/${locked.id}/thumbnail`, query: { key: sharedKey } },
        { name: 'link original', path: `/assets/${locked.id}/original`, query: { key: sharedKey } },
      ],
      {},
    );
    expectNoTrace(linkAnswers, [locked.id, detected.id, 'locked-secret', 'detected-secret']);
    for (const name of ['link thumbnail', 'link original']) {
      expect(linkAnswers.find((answer) => answer.name === name)!.status, name).toBeGreaterThanOrEqual(400);
    }
  });

  it("never gives an unlocked administrator another owner's Locked item, name or count", async () => {
    await unlock(admin.accessToken);
    const answers = await readAll(
      [
        ...oneItemReads(locked.id),
        ...oneItemReads(detected.id),
        { name: 'admin search', method: 'post', path: '/search/metadata', body: { id: locked.id } },
        {
          name: 'admin search filter',
          method: 'post',
          path: '/search/metadata',
          body: { filter: { id: { eq: detected.id }, visibility: { eq: 'timeline' } } },
        },
        { name: 'admin album', path: `/albums/${albumId}` },
        {
          name: 'admin user statistics',
          path: `/admin/users/${owner.userId}/statistics`,
          query: { visibility: 'locked' },
        },
      ],
      bearer(admin.accessToken),
    );
    expectNoTrace(answers, [locked.id, detected.id, 'locked-secret', 'detected-secret']);
    for (const { name, status } of answers) {
      if (!name.startsWith('download') && !name.startsWith('admin search')) {
        expect(status, name).toBeGreaterThanOrEqual(400);
      }
    }
    const { body: server } = await request(app).get('/server/statistics').set(bearer(admin.accessToken)).expect(200);
    expect(server.photos).toBe(2);
  });
});
