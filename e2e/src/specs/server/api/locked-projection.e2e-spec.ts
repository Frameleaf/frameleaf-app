import { LoginResponseDto, SharedLinkType } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const byId = (a: string, b: string) => a.localeCompare(b);

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
      expect((text ?? '').includes(secret), `${name} mentions ${secret}`).toBe(false);
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
 * FL-195 (owner decisions, September 27, 2026): unlocked, the owner's marks, detections, rule matches
 * and items moved from the old Locked folder behave like any other item in every one of those reads.
 * Locked, they keep their places and associations but show nowhere: a memory holding one of them is
 * hidden entirely, and a Studio poster showing one falls back to its placeholder.
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
  let plainMemoryId: string;
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
  const partnerCopyIds: Record<string, string> = {};
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
    return utils.createAsset(owner.accessToken, {
      assetData: { filename: `${name}.png` },
      fileCreatedAt: '2021-06-15T10:00:00.000Z',
      fileModifiedAt: '2021-06-15T10:00:00.000Z',
    });
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
    // Let extraction settle before writing coordinates and tags, so it cannot overwrite either.
    for (const queue of ['sidecar', 'metadataExtraction'] as const) {
      await utils.waitForQueueFinish(admin.accessToken, queue);
    }
    for (const asset of [plain, locked, detected, legacy, ruleMatch]) {
      await request(app)
        .put(`/assets/${asset.id}`)
        .set(bearer(owner.accessToken))
        .send({ latitude: 48.8566, longitude: 2.3522, dateTimeOriginal: '2021-06-15T10:00:00.000Z' })
        .expect(200);
    }
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
    // the control: a memory of visible items only shows whatever the session
    const { body: plainMemory } = await request(app)
      .post('/memories')
      .set(bearer(owner.accessToken))
      .send({
        type: 'on_this_day',
        data: { year: 2019 },
        memoryAt: '2019-06-15T00:00:00.000Z',
        assetIds: [plain.id],
      })
      .expect(201);
    plainMemoryId = plainMemory.id;
    const link = await utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Album, albumId });
    sharedKey = link.key;

    for (const user of [owner, admin, partner]) {
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

    // FL-326: shared once every lock and rule is in place, so each copy is inserted as locked as its
    // source (the locks above are written directly, without the event that re-mirrors existing copies)
    await utils.createPartner(owner.accessToken, partner.userId);
    for (const asset of [plain, locked, detected, legacy, ruleMatch]) {
      partnerCopyIds[asset.id] = await utils.waitForPartnerCopy(partner.userId, asset.id);
    }

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
  }, 90_000);

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

  it("finds the owner's marks, detections, rule matches and old-folder items everywhere once unlocked (FL-195)", async () => {
    await unlock(owner.accessToken);
    // in the album, the memory and the person; the old-folder item is in none of them
    const revealed = [plain.id, locked.id, detected.id, ruleMatch.id];
    const library = [...revealed, legacy.id];
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

    // every library-wide read lists all five, the item moved from the old Locked folder included
    for (const name of [
      'timeline bucket',
      'search metadata',
      'search timeline',
      'search filter',
      'search random timeline',
      'map markers',
    ]) {
      for (const id of library) {
        expect(answer(name).text, `${name} finds ${id}`).toContain(id);
      }
    }
    // and every read of the album or the memory lists its four
    for (const name of ['album timeline bucket', 'memory', 'album bucket', 'download info']) {
      for (const id of revealed) {
        expect(answer(name).text, `${name} finds ${id}`).toContain(id);
      }
    }

    // each item's own folder lists it (originals sit in per-asset folders), the old-folder item's too
    for (const { id } of [locked, detected, ruleMatch, legacy]) {
      const { body: info } = await request(app).get(`/assets/${id}`).set(bearer(owner.accessToken)).expect(200);
      const { text } = await request(app)
        .get('/view/folder')
        .query({ path: info.originalPath.replace(/\/[^/]+$/, '') })
        .set(bearer(owner.accessToken))
        .expect(200);
      expect(text, `folder of ${id}`).toContain(id);
    }

    // and every count counts them
    expect(json('timeline buckets')).toEqual([{ timeBucket: '2021-06-01', count: 5 }]);
    expect(json('person buckets')).toEqual([{ timeBucket: '2021-06-01', count: 4 }]);
    expect(json('tag buckets')).toEqual([{ timeBucket: '2021-06-01', count: 3 }]);
    for (const id of [locked.id, detected.id, ruleMatch.id]) {
      expect(answer('search tag filter').text, `tag filter finds ${id}`).toContain(id);
    }
    expect(json('search statistics timeline').total).toBe(5);
    expect(json('search statistics filter').total).toBe(5);
    expect(json('asset statistics').total).toBe(5);
    expect(json('timeline asset statistics').total).toBe(5);
    expect(json('album').assetCount).toBe(4);
    expect(json('memory').assets).toHaveLength(4);
    expect(json('person statistics').assets).toBe(4);
    const people = json('people');
    expect(people.people.find((row: { id: string }) => row.id === personId)?.assetCount).toBe(4);
    const tagStats = json('tag statistics');
    expect(tagStats.find((row: { id: string }) => row.id === tripTagId)?.count).toBe(3);
    expect(json('search histogram timeline').total).toBe(5);
    // memories holding locked items show normally once unlocked, with all their photos
    const memories = json('memories').map((memory: { id: string }) => memory.id);
    for (const id of [memoryId, lockedOnlyMemoryId, plainMemoryId]) {
      expect(memories, `memories list ${id}`).toContain(id);
    }
    expect(json('memory statistics').total).toBe(3);

    // Studio: the project holds the mark and the detection and every source resolves
    const project = json('studio project');
    expect(project.resources, JSON.stringify(project)).toEqual(
      expect.objectContaining({ complete: true, refusedCount: 0 }),
    );
    expect(project.resources.hiddenSources).toEqual([]);
    // a revealed lock can be the poster, like any other item; it is hidden again while locked
    const { body: posted } = await request(app)
      .put(`/studio/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .send({ thumbnailAssetId: locked.id })
      .expect(200);
    expect(posted.thumbnailAssetId).toBe(locked.id);
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
        { name: 'studio projects', path: '/studio/projects' },
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
      // FL-195 follow-up: a memory holding even one hidden photo is hidden entirely while locked
      memoryId,
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
    expect(answers.find((answer) => answer.name === 'memory')!.status).toBeGreaterThanOrEqual(400);
    expect(count('memories').map((memory: { id: string }) => memory.id)).toEqual([plainMemoryId]);
    expect(count('memory statistics').total).toBe(1);
    expect(count('person statistics').assets).toBe(1);
    // FL-195: the project keeps its references; while locked they are refused, and the owner is told
    // which to hide in the editor rather than show as missing media
    const { body: project } = await request(app)
      .get(`/studio/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(project.resources).toEqual(expect.objectContaining({ complete: false, refusedCount: 2 }));
    expect(project.resources.hiddenSources).toEqual([locked.id, detected.id].toSorted((a, b) => a.localeCompare(b)));
    // the poster keeps its place but shows the placeholder while locked, and shows again once unlocked
    expect(project.thumbnailAssetId).toBeNull();
    for (const path of [`/memories/${memoryId}`, `/memories/${lockedOnlyMemoryId}`]) {
      const { status } = await request(app).get(path).set(bearer(owner.accessToken));
      expect(status, path).toBeGreaterThanOrEqual(400);
    }
    await unlock(owner.accessToken);
    const { body: unlockedProject } = await request(app)
      .get(`/studio/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(unlockedProject.thumbnailAssetId).toBe(locked.id);
    await request(app).get(`/memories/${memoryId}`).set(bearer(owner.accessToken)).expect(200);
    await lock(owner.accessToken);

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
    await lock(partner.accessToken);
    const hiddenCopyIds = hiddenIds().map((id) => partnerCopyIds[id]);
    const { body: plainCopy } = await request(app)
      .get(`/assets/${partnerCopyIds[plain.id]}`)
      .set(bearer(partner.accessToken))
      .expect(200);
    expect(plainCopy).toMatchObject({ id: partnerCopyIds[plain.id], ownerId: partner.userId });
    const partnerAnswers = await readAll(
      [
        { name: 'own buckets', path: '/timeline/buckets', query: { visibility: 'timeline' } },
        {
          name: 'own bucket',
          path: '/timeline/bucket',
          query: { visibility: 'timeline', timeBucket: '2021-06-01' },
        },
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
        ...hiddenCopyIds.flatMap((id) => oneItemReads(id)),
      ],
      bearer(partner.accessToken),
    );
    expectNoTrace(partnerAnswers, [
      ...hiddenIds(),
      ...hiddenCopyIds,
      'locked-secret',
      'detected-secret',
      'legacy-secret',
      'rule-secret',
    ]);
    for (const id of hiddenCopyIds) {
      for (const read of oneItemReads(id)) {
        expect(partnerAnswers.find(({ name }) => name === read.name)!.status, read.name).toBeGreaterThanOrEqual(400);
      }
    }
    expect(JSON.parse(partnerAnswers.find(({ name }) => name === 'own buckets')!.text)).toEqual([
      { timeBucket: '2021-06-01', count: 1 },
    ]);
    expect(partnerAnswers.find(({ name }) => name === 'own bucket')!.text).toContain(partnerCopyIds[plain.id]);

    // The recipient's PIN reveals their copies, and never grants access to the source rows.
    await unlock(partner.accessToken);
    for (const id of hiddenCopyIds) {
      const { body } = await request(app).get(`/assets/${id}`).set(bearer(partner.accessToken)).expect(200);
      expect(body).toMatchObject({ id, ownerId: partner.userId });
    }
    for (const id of hiddenIds()) {
      await request(app).get(`/assets/${id}`).set(bearer(partner.accessToken)).expect(400);
    }
    await lock(partner.accessToken);

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
    await utils.waitForAllQueuesFinish(admin.accessToken);
    const db = await utils.connectDatabase();
    const sources = [plain.id, locked.id, detected.id, legacy.id, ruleMatch.id];
    const { rows: copies } = await db.query<{
      id: string;
      ownerId: string;
      sourceAssetId: string;
      rootOwnerId: string;
      reason: string | null;
    }>(
      `SELECT copy.id, copy."ownerId", origin."sourceAssetId", origin."rootOwnerId", lock.reason
       FROM public.asset_origin origin JOIN public.asset copy ON copy.id = origin."assetId"
       LEFT JOIN public.asset_lock lock ON lock."assetId" = copy.id
       WHERE origin."ownerId" = $1 AND origin."sourceAssetId" = ANY($2::uuid[])`,
      [partner.userId, sources],
    );
    expect(copies).toHaveLength(5);
    expect(copies.map(({ sourceAssetId }) => sourceAssetId).toSorted(byId)).toEqual(sources.toSorted(byId));
    for (const copy of copies) {
      expect(copy.id).toBe(partnerCopyIds[copy.sourceAssetId]);
      expect(copy.ownerId).toBe(partner.userId);
      expect(copy.rootOwnerId).toBe(owner.userId);
      expect(sources).not.toContain(copy.id);
      if (copy.sourceAssetId === plain.id) {
        expect(copy.reason).toBeNull();
      } else {
        expect(copy.reason).not.toBeNull();
      }
    }
    // Rule-matched copies carry an explicit lock; the source rule still belongs to its owner.
    const { rows: counted } = await db.query<{ id: string; ownerId: string }>(
      `SELECT asset.id, asset."ownerId" FROM public.asset
       LEFT JOIN public.asset_lock lock ON lock."assetId" = asset.id
       WHERE asset."deletedAt" IS NULL AND asset.type = 'IMAGE'
         AND asset.visibility NOT IN ('hidden', 'locked') AND lock."assetId" IS NULL ORDER BY asset.id`,
    );
    expect(counted).toEqual(
      [
        { id: plain.id, ownerId: owner.userId },
        { id: ruleMatch.id, ownerId: owner.userId },
        { id: partnerCopyIds[plain.id], ownerId: partner.userId },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    const protectedCopies = copies.filter(({ sourceAssetId }) => sourceAssetId !== plain.id);
    const copyAnswers = await readAll(
      protectedCopies.flatMap(({ id }) => oneItemReads(id)),
      bearer(admin.accessToken),
    );
    expectNoTrace(
      copyAnswers,
      protectedCopies.map(({ id }) => id),
    );
    for (const { status } of copyAnswers) {
      expect(status).toBeGreaterThanOrEqual(400);
    }
    const { body: server } = await request(app).get('/server/statistics').set(bearer(admin.accessToken)).expect(200);
    // the owner's two visible items and the partner's copy of the plain one; every other copy is locked
    expect(server.photos).toBe(3);
  }, 90_000);
});

/**
 * FL-195 follow-up (owner decision, September 27, 2026): an export rendered before its source was
 * locked is hidden while the session is locked — its version, its library item and anything shared
 * of it — and shows again once unlocked. Exports are judged by their sources as they stand now.
 */
describe('Studio exports rendered before their source was locked (FL-195 follow-up)', () => {
  const pinCode = '975310';
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let partner: LoginResponseDto;
  let member: LoginResponseDto;
  let source: { id: string };
  let result: { id: string };
  let laterSource: { id: string };
  let laterResult: { id: string };
  let directSource: { id: string };
  let directResult: { id: string };
  let directVersionId: string;
  let projectId: string;
  let versionId: string;
  let laterVersionId: string;
  let albumId: string;
  let sharedKey: string;

  const unlock = (token: string) =>
    request(app).post('/auth/session/unlock').set(bearer(token)).send({ pinCode }).expect(204);

  const newAsset = (name: string) =>
    utils.createAsset(owner.accessToken, {
      assetData: { filename: `${name}.png` },
      fileCreatedAt: '2021-06-15T10:00:00.000Z',
      fileModifiedAt: '2021-06-15T10:00:00.000Z',
    });

  const exportReads = (): Read[] => [
    { name: 'exports', path: `/studio/projects/${projectId}/exports` },
    { name: 'export', path: `/studio/exports/${versionId}` },
    { name: 'later export', path: `/studio/exports/${laterVersionId}` },
    { name: 'timeline bucket', path: '/timeline/bucket', query: { visibility: 'timeline', timeBucket: '2021-06-01' } },
    { name: 'search', method: 'post', path: '/search/metadata', body: {} },
    { name: 'album', path: `/albums/${albumId}` },
    ...oneItemReads(result.id),
  ];

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
    partner = await utils.userSetup(admin.accessToken, createUserDto.user2);
    member = await utils.userSetup(admin.accessToken, createUserDto.user3);

    source = await newAsset('export-source');
    result = await newAsset('export-render');
    laterSource = await newAsset('later-source');
    laterResult = await newAsset('later-render');
    directSource = await newAsset('direct-source');
    directResult = await newAsset('direct-render');

    const { body: project } = await request(app)
      .post('/studio/projects')
      .set(bearer(owner.accessToken))
      .send({ name: 'FL-195 export', clientId: 'fl-195-export' })
      .expect(201);
    projectId = project.id;
    // rendered and published while every source was visible
    versionId = await utils.seedStudioExport({
      ownerId: owner.userId,
      projectId,
      resultAssetId: result.id,
      sourceAssetIds: [source.id],
      version: 1,
    });
    laterVersionId = await utils.seedStudioExport({
      ownerId: owner.userId,
      projectId,
      resultAssetId: laterResult.id,
      sourceAssetIds: [laterSource.id],
      version: 2,
    });
    directVersionId = await utils.seedStudioExport({
      ownerId: owner.userId,
      projectId,
      resultAssetId: directResult.id,
      sourceAssetIds: [directSource.id],
      version: 3,
    });

    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'Renders',
      assetIds: [result.id],
      albumUsers: [{ userId: member.userId, role: 'viewer' as never }],
    });
    albumId = album.id;
    const link = await utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Album, albumId });
    sharedKey = link.key;
    await utils.createPartner(owner.accessToken, partner.userId);
    for (const user of [owner, admin]) {
      await request(app).post('/auth/pin-code').set(bearer(user.accessToken)).send({ pinCode }).expect(204);
    }

    // the source is locked after the render: its export follows it
    await request(app)
      .post('/assets/lock')
      .set(bearer(owner.accessToken))
      .send({ ids: [source.id] })
      .expect(204);
    // a lock that reached the other source without going through a lock request: judged at read time
    await utils.setAssetLock(laterSource.id, 'detected');
    // the third export inherits its source's lock, and its owner, unlocked (the export is Locked now),
    // then locks it directly as well
    await request(app)
      .post('/assets/lock')
      .set(bearer(owner.accessToken))
      .send({ ids: [directSource.id] })
      .expect(204);
    await unlock(owner.accessToken);
    await request(app)
      .post('/assets/lock')
      .set(bearer(owner.accessToken))
      .send({ ids: [directResult.id] })
      .expect(204);
    await lock(owner.accessToken);
  });

  it('hides the export, its library item and its share while the session is locked', async () => {
    await lock(owner.accessToken);
    const answers = await readAll(exportReads(), bearer(owner.accessToken));
    expectNoTrace(answers, [versionId, laterVersionId, result.id, 'export-render']);
    const answer = (name: string) => answers.find((read) => read.name === name)!;
    expect(JSON.parse(answer('exports').text)).toEqual(expect.objectContaining({ items: [], total: 0 }));
    for (const name of ['export', 'later export', `asset ${result.id}`, `thumbnail ${result.id}`]) {
      expect(answer(name).status, name).toBeGreaterThanOrEqual(400);
    }
    expect(JSON.parse(answer('album').text).assetCount).toBe(0);
  });

  it('shows it normally once the session is unlocked', async () => {
    await unlock(owner.accessToken);
    const answers = await readAll(exportReads(), bearer(owner.accessToken));
    const answer = (name: string) => answers.find((read) => read.name === name)!;
    const listed = JSON.parse(answer('exports').text);
    expect(listed.total).toBe(3);
    expect(listed.items.map((item: { id: string }) => item.id).toSorted(byId)).toEqual(
      [versionId, laterVersionId, directVersionId].toSorted(byId),
    );
    const version = JSON.parse(answer('export').text);
    expect(version).toEqual(expect.objectContaining({ id: versionId, resultAssetId: result.id, locked: true }));
    expect(answer('later export').status).toBe(200);
    expect(answer('timeline bucket').text).toContain(result.id);
    expect(answer(`asset ${result.id}`).status).toBe(200);
    await lock(owner.accessToken);
  });

  it('never shows it to a partner, an album member, a shared link or an unlocked administrator', async () => {
    await unlock(owner.accessToken);
    const secrets = [versionId, laterVersionId, result.id, 'export-render'];

    const partnerAnswers = await readAll(
      [
        { name: 'partner bucket', path: '/timeline/bucket', query: { userId: owner.userId, timeBucket: '2021-06-01' } },
        { name: 'partner search', method: 'post', path: '/search/metadata', body: { withPartners: true } },
        { name: 'partner export', path: `/studio/exports/${versionId}` },
        { name: 'partner exports', path: `/studio/projects/${projectId}/exports` },
        ...oneItemReads(result.id),
      ],
      bearer(partner.accessToken),
    );
    expectNoTrace(partnerAnswers, secrets);

    const memberAnswers = await readAll(
      [
        { name: 'member album', path: `/albums/${albumId}` },
        { name: 'member bucket', path: '/timeline/bucket', query: { albumId, timeBucket: '2021-06-01' } },
        { name: 'member export', path: `/studio/exports/${versionId}` },
        ...oneItemReads(result.id),
      ],
      bearer(member.accessToken),
    );
    expectNoTrace(memberAnswers, secrets);

    const linkAnswers = await readAll(
      [
        { name: 'link album', path: `/albums/${albumId}`, query: { key: sharedKey } },
        { name: 'link bucket', path: '/timeline/bucket', query: { albumId, key: sharedKey, timeBucket: '2021-06-01' } },
        { name: 'link thumbnail', path: `/assets/${result.id}/thumbnail`, query: { key: sharedKey } },
      ],
      {},
    );
    expectNoTrace(linkAnswers, secrets);

    await unlock(admin.accessToken);
    const adminAnswers = await readAll(
      [
        { name: 'admin export', path: `/studio/exports/${versionId}` },
        { name: 'admin exports', path: `/studio/projects/${projectId}/exports` },
        ...oneItemReads(result.id),
      ],
      bearer(admin.accessToken),
    );
    expectNoTrace(adminAnswers, secrets);
  });
  it('shows the export again once its sources are unlocked, but never one its owner locked directly', async () => {
    await unlock(owner.accessToken);
    await request(app)
      .post('/assets/unlock')
      .set(bearer(owner.accessToken))
      .send({ ids: [source.id, laterSource.id, directSource.id] })
      .expect(204);
    await lock(owner.accessToken);

    const answers = await readAll(
      [
        ...exportReads(),
        { name: 'direct export', path: `/studio/exports/${directVersionId}` },
        ...oneItemReads(directResult.id),
      ],
      bearer(owner.accessToken),
    );
    const answer = (name: string) => answers.find((read) => read.name === name)!;
    const listed = JSON.parse(answer('exports').text);
    expect(listed.items.map((item: { id: string }) => item.id).toSorted(byId)).toEqual(
      [versionId, laterVersionId].toSorted(byId),
    );
    expect(JSON.parse(answer('export').text)).toEqual(
      expect.objectContaining({ id: versionId, resultAssetId: result.id, locked: false }),
    );
    expect(answer('later export').status).toBe(200);
    expect(answer('timeline bucket').text).toContain(result.id);
    expect(answer(`asset ${result.id}`).status).toBe(200);
    expect(JSON.parse(answer('album').text).assetCount).toBe(1);

    // the directly locked export stays hidden, its entry, library item and download included
    expectNoTrace(answers, [directVersionId, directResult.id, 'direct-render']);
    for (const name of ['direct export', `asset ${directResult.id}`, `original ${directResult.id}`]) {
      expect(answer(name).status, name).toBeGreaterThanOrEqual(400);
    }
    // and its share: a shared link never shows it
    const { text } = await request(app).get(`/albums/${albumId}`).query({ key: sharedKey });
    expect(text).not.toContain(directResult.id);
  });
});
