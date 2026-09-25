import { getPerson, LoginResponseDto, PeopleListItemDto, PersonResponseDto } from '@immich/sdk';
import { createUserDto, uuidDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('/people', () => {
  let admin: LoginResponseDto;
  let visiblePerson: PersonResponseDto;
  let hiddenPerson: PersonResponseDto;
  let multipleAssetsPerson: PersonResponseDto;

  let nameAlicePerson: PersonResponseDto;
  let nameBobPerson: PersonResponseDto;
  let nameCharliePerson: PersonResponseDto;
  let nameNullPerson4Assets: PersonResponseDto;
  let nameNullPerson3Assets: PersonResponseDto;
  let nameNullPerson1Asset: PersonResponseDto;
  let nameBillPersonFavourite: PersonResponseDto;
  let nameFreddyPersonFavourite: PersonResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    [
      visiblePerson,
      hiddenPerson,
      multipleAssetsPerson,
      nameCharliePerson,
      nameBobPerson,
      nameAlicePerson,
      nameNullPerson4Assets,
      nameNullPerson3Assets,
      nameNullPerson1Asset,
      nameBillPersonFavourite,
      nameFreddyPersonFavourite,
    ] = await Promise.all([
      utils.createPerson(admin.accessToken, {
        name: 'visible_person',
      }),
      utils.createPerson(admin.accessToken, {
        name: 'hidden_person',
        isHidden: true,
      }),
      utils.createPerson(admin.accessToken, {
        name: 'multiple_assets_person',
      }),
      // --- Setup for the specific sorting test ---
      utils.createPerson(admin.accessToken, {
        name: 'Charlie',
      }),
      utils.createPerson(admin.accessToken, {
        name: 'Bob',
      }),
      utils.createPerson(admin.accessToken, {
        name: 'Alice',
      }),
      utils.createPerson(admin.accessToken, {
        name: '',
      }),
      utils.createPerson(admin.accessToken, {
        name: '',
      }),
      utils.createPerson(admin.accessToken, {
        name: '',
      }),
      utils.createPerson(admin.accessToken, {
        name: 'Bill',
        isFavorite: true,
      }),
      utils.createPerson(admin.accessToken, {
        name: 'Freddy',
        isFavorite: true,
      }),
    ]);

    const asset1 = await utils.createAsset(admin.accessToken);
    const asset2 = await utils.createAsset(admin.accessToken);
    const asset3 = await utils.createAsset(admin.accessToken);
    const asset4 = await utils.createAsset(admin.accessToken);

    await Promise.all([
      utils.createFace({ assetId: asset1.id, personGroupId: visiblePerson.id }),
      utils.createFace({ assetId: asset1.id, personGroupId: hiddenPerson.id }),
      utils.createFace({ assetId: asset1.id, personGroupId: multipleAssetsPerson.id }),
      utils.createFace({ assetId: asset1.id, personGroupId: multipleAssetsPerson.id }),
      utils.createFace({ assetId: asset2.id, personGroupId: multipleAssetsPerson.id }),
      utils.createFace({ assetId: asset3.id, personGroupId: multipleAssetsPerson.id }), // 4 assets
      // Named persons
      utils.createFace({ assetId: asset1.id, personGroupId: nameCharliePerson.id }), // 1 asset
      utils.createFace({ assetId: asset1.id, personGroupId: nameBobPerson.id }),
      utils.createFace({ assetId: asset2.id, personGroupId: nameBobPerson.id }), // 2 assets
      utils.createFace({ assetId: asset1.id, personGroupId: nameAlicePerson.id }), // 1 asset
      // Null-named person 4 assets
      utils.createFace({ assetId: asset1.id, personGroupId: nameNullPerson4Assets.id }),
      utils.createFace({ assetId: asset2.id, personGroupId: nameNullPerson4Assets.id }),
      utils.createFace({ assetId: asset3.id, personGroupId: nameNullPerson4Assets.id }),
      utils.createFace({ assetId: asset4.id, personGroupId: nameNullPerson4Assets.id }), // 4 assets
      // Null-named person 3 assets
      utils.createFace({ assetId: asset1.id, personGroupId: nameNullPerson3Assets.id }),
      utils.createFace({ assetId: asset2.id, personGroupId: nameNullPerson3Assets.id }),
      utils.createFace({ assetId: asset3.id, personGroupId: nameNullPerson3Assets.id }), // 3 assets
      // Null-named person 1 asset
      utils.createFace({ assetId: asset3.id, personGroupId: nameNullPerson1Asset.id }),
      // Favourite People
      utils.createFace({ assetId: asset1.id, personGroupId: nameFreddyPersonFavourite.id }),
      utils.createFace({ assetId: asset2.id, personGroupId: nameFreddyPersonFavourite.id }),
      utils.createFace({ assetId: asset1.id, personGroupId: nameBillPersonFavourite.id }),
    ]);
  });

  describe('GET /people', () => {
    beforeEach(async () => {});
    it('should return all people (including hidden)', async () => {
      const { status, body } = await request(app)
        .get('/people')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query({ withHidden: true });

      expect(status).toBe(200);
      expect(body).toEqual({
        hasNextPage: false,
        total: 11,
        hidden: 1,
        people: [
          expect.objectContaining({ name: 'Freddy' }),
          expect.objectContaining({ name: 'Bill' }),
          expect.objectContaining({ name: 'multiple_assets_person' }),
          expect.objectContaining({ name: 'Bob' }),
          expect.objectContaining({ name: 'Alice' }),
          expect.objectContaining({ name: 'Charlie' }),
          expect.objectContaining({ name: 'visible_person' }),
          expect.objectContaining({ id: nameNullPerson4Assets.id, name: '' }),
          expect.objectContaining({ id: nameNullPerson3Assets.id, name: '' }),
          expect.objectContaining({ name: 'hidden_person' }), // Should really be before the null names
        ],
      });
    });

    it('should sort visible people by asset count (desc), then by name (asc, nulls last)', async () => {
      const { status, body } = await request(app).get('/people').set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body.hasNextPage).toBe(false);
      expect(body.total).toBe(11); // All persons
      expect(body.hidden).toBe(1); // 'hidden_person'

      const people = body.people as PersonResponseDto[];

      expect(people.map((p) => p.id)).toEqual([
        nameFreddyPersonFavourite.id, // name: 'Freddy', count: 2
        nameBillPersonFavourite.id, // name: 'Bill', count: 1
        multipleAssetsPerson.id, // name: 'multiple_assets_person', count: 3
        nameBobPerson.id, // name: 'Bob', count: 2
        nameAlicePerson.id, // name: 'Alice', count: 1
        nameCharliePerson.id, // name: 'Charlie', count: 1
        visiblePerson.id, // name: 'visible_person', count: 1
        nameNullPerson4Assets.id, // name: '', count: 4
        nameNullPerson3Assets.id, // name: '', count: 3
      ]);

      expect(people.some((p) => p.id === hiddenPerson.id)).toBe(false);
    });

    it('should include per-person asset counts and the latest capture date', async () => {
      const { status, body } = await request(app).get('/people').set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      const people = body.people as PeopleListItemDto[];
      expect(people.find((p) => p.id === multipleAssetsPerson.id)).toEqual(
        expect.objectContaining({ assetCount: 3, lastSeenAt: expect.any(String) }),
      );
      expect(people.find((p) => p.id === nameNullPerson4Assets.id)).toEqual(expect.objectContaining({ assetCount: 4 }));
    });

    it('should return only visible people', async () => {
      const { status, body } = await request(app).get('/people').set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({
        hasNextPage: false,
        total: 11,
        hidden: 1,
        people: [
          expect.objectContaining({ name: 'Freddy' }),
          expect.objectContaining({ name: 'Bill' }),
          expect.objectContaining({ name: 'multiple_assets_person' }),
          expect.objectContaining({ name: 'Bob' }),
          expect.objectContaining({ name: 'Alice' }),
          expect.objectContaining({ name: 'Charlie' }),
          expect.objectContaining({ name: 'visible_person' }),
          expect.objectContaining({ id: nameNullPerson4Assets.id, name: '' }),
          expect.objectContaining({ id: nameNullPerson3Assets.id, name: '' }),
        ],
      });
    });

    it('should support pagination', async () => {
      const { status, body } = await request(app)
        .get('/people')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query({ withHidden: true, page: 5, size: 1 });

      expect(status).toBe(200);
      expect(body).toEqual({
        hasNextPage: true,
        total: 11,
        hidden: 1,
        people: [expect.objectContaining({ name: 'Alice' })],
      });
    });
  });

  describe('GET /people/:id', () => {
    it('should throw error if person with id does not exist', async () => {
      const { status, body } = await request(app)
        .get(`/people/${uuidDto.notFound}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(404);
      expect(body).toEqual(errorDto.notFound('Person not found'));
    });

    it('should return person information', async () => {
      const { status, body } = await request(app)
        .get(`/people/${visiblePerson.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: visiblePerson.id }));
    });
  });

  describe('GET /people/:id/statistics', () => {
    it('should throw error if person with id does not exist', async () => {
      const { status, body } = await request(app)
        .get(`/people/${uuidDto.notFound}/statistics`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(404);
      expect(body).toEqual(errorDto.notFound('Person not found'));
    });

    it('should return the correct number of assets', async () => {
      const { status, body } = await request(app)
        .get(`/people/${multipleAssetsPerson.id}/statistics`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ assets: 3 }));
    });
  });

  describe('POST /people', () => {
    it('should create a person', async () => {
      const { status, body } = await request(app)
        .post(`/people`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          name: 'New Person',
          birthDate: '1990-01-01',
          color: '#333',
        });
      expect(status).toBe(201);
      expect(body).toMatchObject({
        id: expect.any(String),
        name: 'New Person',
        birthDate: '1990-01-01',
      });
    });

    it('should create a favorite person', async () => {
      const { status, body } = await request(app)
        .post(`/people`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          name: 'New Favorite Person',
          isFavorite: true,
        });
      expect(status).toBe(201);
      expect(body).toMatchObject({
        id: expect.any(String),
        name: 'New Favorite Person',
        isFavorite: true,
      });
    });
  });

  describe('PUT /people/:id', () => {
    it('should update a date of birth', async () => {
      const { status, body } = await request(app)
        .put(`/people/${visiblePerson.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ birthDate: '1990-01-01' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ birthDate: '1990-01-01' });
    });

    it('should clear a date of birth', async () => {
      const { status, body } = await request(app)
        .put(`/people/${visiblePerson.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ birthDate: null });
      expect(status).toBe(200);
      expect(body).toMatchObject({ birthDate: null });
    });

    it('should set a color', async () => {
      const { status, body } = await request(app)
        .put(`/people/${visiblePerson.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ color: '#555' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ color: '#555' });
    });

    it('should clear a color', async () => {
      const { status, body } = await request(app)
        .put(`/people/${visiblePerson.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ color: null });
      expect(status).toBe(200);
      expect(body.color).toBeUndefined();
    });

    it('should mark a person as favorite', async () => {
      const person = await utils.createPerson(admin.accessToken, {
        name: 'visible_person',
      });

      expect(person.isFavorite).toBe(false);

      const { status, body } = await request(app)
        .put(`/people/${person.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isFavorite: true });
      expect(status).toBe(200);
      expect(body).toMatchObject({ isFavorite: true });

      const person2 = await getPerson({ id: person.id }, { headers: asBearerAuth(admin.accessToken) });
      expect(person2).toMatchObject({ id: person.id, isFavorite: true });
    });
  });

  describe('POST /people/:id/merge', () => {
    it('should not supporting merging a person into themselves', async () => {
      const { status, body } = await request(app)
        .post(`/people/${visiblePerson.id}/merge`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ids: [visiblePerson.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Cannot merge a person into themselves'));
    });
  });

  describe('PUT /people/merge-suggestions/verdicts', () => {
    it('should require authentication', async () => {
      const { status } = await request(app)
        .put('/people/merge-suggestions/verdicts')
        .send({ personId: visiblePerson.id, suggestionId: hiddenPerson.id, verdict: 'different' });
      expect(status).toBe(401);
    });

    it('should record a verdict and undo it', async () => {
      const { status, body } = await request(app)
        .put('/people/merge-suggestions/verdicts')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ personId: visiblePerson.id, suggestionId: nameAlicePerson.id, verdict: 'later' });
      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          personId: [visiblePerson.id, nameAlicePerson.id].toSorted((a, b) => a.localeCompare(b))[0],
          verdict: 'later',
        }),
      );

      const undo = await request(app)
        .delete('/people/merge-suggestions/verdicts')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ personId: nameAlicePerson.id, suggestionId: visiblePerson.id });
      expect(undo.status).toBe(204);

      const again = await request(app)
        .delete('/people/merge-suggestions/verdicts')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ personId: nameAlicePerson.id, suggestionId: visiblePerson.id });
      expect(again.status).toBe(404);
    });
  });

  // FL-37: manage-hidden bulk review, rejected merges, merges, reassignment and permission changes
  describe('PUT /people (show and hide people in bulk)', () => {
    it('hides and shows a named and an unnamed person together', async () => {
      const [named, unnamed] = await Promise.all([
        utils.createPerson(admin.accessToken, { name: 'Bulk named' }),
        utils.createPerson(admin.accessToken, { name: '' }),
      ]);
      const asset = await utils.createAsset(admin.accessToken);
      await utils.createFace({ assetId: asset.id, personGroupId: named.id });
      await utils.createFace({ assetId: asset.id, personGroupId: unnamed.id });

      const hide = await request(app)
        .put('/people')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          people: [
            { id: named.id, isHidden: true },
            { id: unnamed.id, isHidden: true },
          ],
        });
      expect(hide.status).toBe(200);
      expect(hide.body).toEqual([
        { id: named.id, success: true },
        { id: unnamed.id, success: true },
      ]);

      const visible = await request(app)
        .get('/people')
        .query({ withHidden: false })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      const visibleIds = (visible.body.people as PeopleListItemDto[]).map(({ id }) => id);
      expect(visibleIds).not.toContain(named.id);
      expect(visibleIds).not.toContain(unnamed.id);

      const everyone = await request(app)
        .get('/people')
        .query({ withHidden: true })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(everyone.body.people).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: named.id, isHidden: true }),
          expect.objectContaining({ id: unnamed.id, name: '', isHidden: true }),
        ]),
      );
      expect(everyone.body.hidden).toBeGreaterThanOrEqual(2);

      const show = await request(app)
        .put('/people')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          people: [
            { id: named.id, isHidden: false },
            { id: unnamed.id, isHidden: false },
          ],
        });
      expect(show.body).toEqual([
        { id: named.id, success: true },
        { id: unnamed.id, success: true },
      ]);
      const shown = await request(app)
        .get('/people')
        .query({ withHidden: false })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect((shown.body.people as PeopleListItemDto[]).map(({ id }) => id)).toEqual(
        expect.arrayContaining([named.id, unnamed.id]),
      );
    });
  });

  describe('merge suggestions and a rejected merge', () => {
    it('drops a pair answered "different" from the suggestions and brings it back on undo', async () => {
      const [first, second] = await Promise.all([
        utils.createPerson(admin.accessToken, { name: 'Twin one' }),
        utils.createPerson(admin.accessToken, { name: 'Twin two' }),
      ]);
      const [assetA, assetB] = await Promise.all([
        utils.createAsset(admin.accessToken),
        utils.createAsset(admin.accessToken),
      ]);
      await utils.createFeaturedFaceWithEmbedding({ assetId: assetA.id, personGroupId: first.id, seed: 7 });
      await utils.createFeaturedFaceWithEmbedding({ assetId: assetB.id, personGroupId: second.id, seed: 7 });
      const pair = (body: { suggestions: { person: { id: string }; suggestion: { id: string } }[] }) =>
        body.suggestions.some(
          ({ person, suggestion }) =>
            [person.id, suggestion.id].toSorted((a, b) => a.localeCompare(b)).join('|') ===
            [first.id, second.id].toSorted((a, b) => a.localeCompare(b)).join('|'),
        );

      const before = await request(app)
        .get('/people/merge-suggestions')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(before.status).toBe(200);
      expect(pair(before.body)).toBe(true);

      const reject = await request(app)
        .put('/people/merge-suggestions/verdicts')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ personId: first.id, suggestionId: second.id, verdict: 'different' });
      expect(reject.status).toBe(200);

      const after = await request(app)
        .get('/people/merge-suggestions')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(pair(after.body)).toBe(false);
      // a rejected merge keeps two people
      await expect(getPerson({ id: first.id }, { headers: asBearerAuth(admin.accessToken) })).resolves.toEqual(
        expect.objectContaining({ id: first.id }),
      );
      await expect(getPerson({ id: second.id }, { headers: asBearerAuth(admin.accessToken) })).resolves.toEqual(
        expect.objectContaining({ id: second.id }),
      );

      await request(app)
        .delete('/people/merge-suggestions/verdicts')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ personId: second.id, suggestionId: first.id })
        .expect(204);
      const restored = await request(app)
        .get('/people/merge-suggestions')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(pair(restored.body)).toBe(true);
    });

    it('never suggests two people whose faces are not alike', async () => {
      const [first, second] = await Promise.all([
        utils.createPerson(admin.accessToken, { name: 'Unalike one' }),
        utils.createPerson(admin.accessToken, { name: 'Unalike two' }),
      ]);
      const asset = await utils.createAsset(admin.accessToken);
      await utils.createFeaturedFaceWithEmbedding({ assetId: asset.id, personGroupId: first.id, seed: 11 });
      await utils.createFeaturedFaceWithEmbedding({ assetId: asset.id, personGroupId: second.id, seed: 300 });

      const { body } = await request(app)
        .get('/people/merge-suggestions')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      const ids = (body.suggestions as { person: { id: string }; suggestion: { id: string } }[]).flatMap(
        ({ person, suggestion }) => [person.id, suggestion.id],
      );
      expect(ids).not.toContain(first.id);
      expect(ids).not.toContain(second.id);
    });
  });

  describe('POST /people/merge', () => {
    it('moves every face into the surviving person and removes the other', async () => {
      const [survivor, merged] = await Promise.all([
        utils.createPerson(admin.accessToken, { name: 'Survivor' }),
        utils.createPerson(admin.accessToken, { name: '', birthDate: '1990-01-01' }),
      ]);
      const [assetA, assetB] = await Promise.all([
        utils.createAsset(admin.accessToken),
        utils.createAsset(admin.accessToken),
      ]);
      await utils.createFace({ assetId: assetA.id, personGroupId: survivor.id });
      await utils.createFace({ assetId: assetB.id, personGroupId: merged.id });

      const { status, body } = await request(app)
        .post('/people/merge')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ids: [survivor.id, merged.id] });
      expect(status).toBe(200);
      expect(body).toEqual([{ id: merged.id, success: true }]);

      const gone = await request(app).get(`/people/${merged.id}`).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(gone.status).toBe(404);
      const kept = await request(app).get(`/people/${survivor.id}`).set('Authorization', `Bearer ${admin.accessToken}`);
      // the survivor keeps its name and takes the birthday it did not have
      expect(kept.body).toEqual(expect.objectContaining({ name: 'Survivor', birthDate: '1990-01-01' }));
      const statistics = await request(app)
        .get(`/people/${survivor.id}/statistics`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(statistics.body).toEqual(expect.objectContaining({ assets: 2 }));
    });
  });

  describe('reassigning and removing faces', () => {
    it('reassigns faces by photo, by face id and removes a face', async () => {
      const [from, to] = await Promise.all([
        utils.createPerson(admin.accessToken, { name: 'Wrongly matched' }),
        utils.createPerson(admin.accessToken, { name: 'Right person' }),
      ]);
      const [assetA, assetB] = await Promise.all([
        utils.createAsset(admin.accessToken),
        utils.createAsset(admin.accessToken),
      ]);
      await utils.createFace({ assetId: assetA.id, personGroupId: from.id });
      await utils.createFace({ assetId: assetB.id, personGroupId: from.id });

      const byPhoto = await request(app)
        .put(`/people/${to.id}/reassign`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ data: [{ personId: from.id, assetId: assetA.id }] });
      expect(byPhoto.status).toBe(200);
      expect(byPhoto.body).toEqual([expect.objectContaining({ id: to.id })]);

      const faces = await request(app)
        .get('/faces')
        .query({ id: assetB.id })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(faces.status).toBe(200);
      const face = (faces.body as { id: string; person: { id: string } | null }[]).find(
        (candidate) => candidate.person?.id === from.id,
      )!;
      const byId = await request(app)
        .put(`/faces/${to.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ id: face.id });
      expect(byId.status).toBe(200);
      expect(byId.body).toEqual(expect.objectContaining({ id: to.id }));

      const statistics = await request(app)
        .get(`/people/${to.id}/statistics`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(statistics.body).toEqual(expect.objectContaining({ assets: 2 }));

      const removed = await request(app)
        .delete(`/faces/${face.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ force: false });
      expect(removed.status).toBe(204);
      const after = await request(app)
        .get('/faces')
        .query({ id: assetB.id })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect((after.body as { id: string }[]).map(({ id }) => id)).not.toContain(face.id);
    });
  });

  describe('date of birth validation', () => {
    it('refuses a date of birth in the future', async () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const update = await request(app)
        .put(`/people/${visiblePerson.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ birthDate: future });
      expect(update.status).toBe(400);
      expect(update.body).toEqual(errorDto.badRequest(expect.stringContaining('Birth date cannot be in the future')));

      const create = await request(app)
        .post('/people')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ name: 'Not born yet', birthDate: future });
      expect(create.status).toBe(400);
    });
  });

  describe("another account's people", () => {
    let user2: LoginResponseDto;
    let ownPerson: PersonResponseDto;
    let adminFaceId: string;
    let adminAssetId: string;

    beforeAll(async () => {
      user2 = await utils.userSetup(admin.accessToken, createUserDto.create('fl37-people'));
      ownPerson = await utils.createPerson(user2.accessToken, { name: 'Own person' });
      const asset = await utils.createAsset(admin.accessToken);
      adminAssetId = asset.id;
      adminFaceId = (await utils.createFeaturedFaceWithEmbedding({
        assetId: asset.id,
        personGroupId: visiblePerson.id,
        seed: 42,
      }))!;
      // the admin shares their library with user2: a partner sees the photos, never the people
      await utils.createPartner(admin.accessToken, user2.userId);
    });

    it('answers every single-person route with 404', async () => {
      const auth = { Authorization: `Bearer ${user2.accessToken}` };
      const notFound = errorDto.notFound('Person not found');

      const get = await request(app).get(`/people/${visiblePerson.id}`).set(auth);
      expect(get.status).toBe(404);
      expect(get.body).toEqual(notFound);

      const statistics = await request(app).get(`/people/${visiblePerson.id}/statistics`).set(auth);
      expect(statistics.status).toBe(404);

      const thumbnail = await request(app).get(`/people/${visiblePerson.id}/thumbnail`).set(auth);
      expect(thumbnail.status).toBe(404);

      const update = await request(app)
        .put(`/people/${visiblePerson.id}`)
        .set(auth)
        .send({ name: 'Taken over', isHidden: true });
      expect(update.status).toBe(404);
      expect(update.body).toEqual(notFound);

      const mergeInto = await request(app)
        .post(`/people/${visiblePerson.id}/merge`)
        .set(auth)
        .send({ ids: [ownPerson.id] });
      expect(mergeInto.status).toBe(404);

      const reassign = await request(app)
        .put(`/people/${visiblePerson.id}/reassign`)
        .set(auth)
        .send({ data: [{ personId: ownPerson.id, assetId: adminAssetId }] });
      expect(reassign.status).toBe(404);

      const verdict = await request(app)
        .put('/people/merge-suggestions/verdicts')
        .set(auth)
        .send({ personId: visiblePerson.id, suggestionId: ownPerson.id, verdict: 'different' });
      expect(verdict.status).toBe(404);

      const faceToTheirPerson = await request(app)
        .put(`/faces/${visiblePerson.id}`)
        .set(auth)
        .send({ id: adminFaceId });
      expect(faceToTheirPerson.status).toBe(404);

      const person = await getPerson({ id: visiblePerson.id }, { headers: asBearerAuth(admin.accessToken) });
      expect(person.name).toBe('visible_person');
      expect(person.isHidden).toBe(false);
    });

    it("refuses another account's faces and bulk changes", async () => {
      const auth = { Authorization: `Bearer ${user2.accessToken}` };

      const faceToOwnPerson = await request(app).put(`/faces/${ownPerson.id}`).set(auth).send({ id: adminFaceId });
      expect(faceToOwnPerson.status).toBe(400);

      const removeFace = await request(app).delete(`/faces/${adminFaceId}`).set(auth).send({ force: false });
      expect(removeFace.status).toBe(400);

      const merge = await request(app)
        .post('/people/merge')
        .set(auth)
        .send({ ids: [ownPerson.id, visiblePerson.id] });
      expect(merge.status).toBe(200);
      expect(merge.body).toEqual([
        expect.objectContaining({ id: visiblePerson.id, success: false, error: 'no_permission' }),
      ]);

      const bulk = await request(app)
        .put('/people')
        .set(auth)
        .send({ people: [{ id: visiblePerson.id, isHidden: true }] });
      expect(bulk.status).toBe(200);
      expect(bulk.body).toEqual([expect.objectContaining({ id: visiblePerson.id, success: false })]);

      await expect(getPerson({ id: visiblePerson.id }, { headers: asBearerAuth(admin.accessToken) })).resolves.toEqual(
        expect.objectContaining({ id: visiblePerson.id, isHidden: false }),
      );
    });

    it("does not list or suggest another account's people", async () => {
      const list = await request(app).get('/people').set('Authorization', `Bearer ${user2.accessToken}`);
      expect((list.body.people as PeopleListItemDto[]).map(({ id }) => id)).not.toContain(visiblePerson.id);
      const suggestions = await request(app)
        .get('/people/merge-suggestions')
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(JSON.stringify(suggestions.body)).not.toContain(visiblePerson.id);
    });
  });
});
