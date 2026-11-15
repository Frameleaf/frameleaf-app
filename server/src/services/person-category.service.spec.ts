import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DEFAULT_PERSON_CATEGORIES, PersonCategoryService } from 'src/services/person-category.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const category = (
  ownerId: string,
  overrides: Partial<{ id: string; name: string; color: string | null; order: number }> = {},
) => ({
  id: newUuid(),
  ownerId,
  name: 'Family',
  color: null,
  order: 0,
  createdAt: new Date('2026-11-15T00:00:00.000Z'),
  updatedAt: new Date('2026-11-15T00:00:00.000Z'),
  ...overrides,
});

describe(PersonCategoryService.name, () => {
  let sut: PersonCategoryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonCategoryService));
    mocks.person.seedCategories.mockResolvedValue(false);
  });

  describe('getAll', () => {
    it('makes Family, Friends and Work the first time an account reads its categories', async () => {
      const auth = AuthFactory.create();
      const seeded = DEFAULT_PERSON_CATEGORIES.map(({ name }, order) => category(auth.user.id, { name, order }));
      mocks.person.getCategories.mockResolvedValueOnce([]).mockResolvedValueOnce(seeded);
      mocks.person.seedCategories.mockResolvedValue(true);

      const result = await sut.getAll(auth);

      expect(mocks.person.seedCategories).toHaveBeenCalledWith(auth.user.id, [
        { name: 'Family', color: null },
        { name: 'Friends', color: null },
        { name: 'Work', color: null },
      ]);
      expect(result.map(({ name }) => name)).toEqual(['Family', 'Friends', 'Work']);
      expect(result[0]).toEqual({
        id: seeded[0].id,
        name: 'Family',
        color: null,
        order: 0,
        createdAt: '2026-11-15T00:00:00.000Z',
        updatedAt: '2026-11-15T00:00:00.000Z',
      });
    });

    it('never makes them again once they were made, even when every category was deleted', async () => {
      const auth = AuthFactory.create();
      mocks.person.getCategories.mockResolvedValue([]);
      mocks.person.seedCategories.mockResolvedValue(false);

      await expect(sut.getAll(auth)).resolves.toEqual([]);
      expect(mocks.person.getCategories).toHaveBeenCalledTimes(1);
    });

    it('does not try to make them while the account has categories', async () => {
      const auth = AuthFactory.create();
      mocks.person.getCategories.mockResolvedValue([category(auth.user.id, { name: 'Climbing' })]);

      await expect(sut.getAll(auth)).resolves.toEqual([expect.objectContaining({ name: 'Climbing' })]);
      expect(mocks.person.seedCategories).not.toHaveBeenCalled();
      expect(mocks.person.getCategories).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('create', () => {
    it("adds a category after the caller's others, making the starting ones first", async () => {
      const auth = AuthFactory.create();
      const created = category(auth.user.id, { name: 'Neighbours', color: '#ff0000', order: 3 });
      mocks.person.createCategory.mockResolvedValue(created);

      await expect(sut.create(auth, { name: 'Neighbours', color: '#ff0000' })).resolves.toEqual(
        expect.objectContaining({ id: created.id, name: 'Neighbours', color: '#ff0000', order: 3 }),
      );
      expect(mocks.person.seedCategories).toHaveBeenCalledWith(auth.user.id, DEFAULT_PERSON_CATEGORIES);
      expect(mocks.person.createCategory).toHaveBeenCalledWith({
        ownerId: auth.user.id,
        name: 'Neighbours',
        color: '#ff0000',
      });
    });

    it('stores no color when none is given', async () => {
      const auth = AuthFactory.create();
      mocks.person.createCategory.mockResolvedValue(category(auth.user.id, { name: 'School' }));

      await sut.create(auth, { name: 'School' });
      expect(mocks.person.createCategory).toHaveBeenCalledWith({ ownerId: auth.user.id, name: 'School', color: null });
    });
  });

  describe('update', () => {
    it("renames, recolors and reorders the caller's own category", async () => {
      const auth = AuthFactory.create();
      const updated = category(auth.user.id, { name: 'Kin', color: null, order: 2 });
      mocks.person.updateCategory.mockResolvedValue(updated);

      await expect(sut.update(auth, updated.id, { name: 'Kin', color: null, order: 2 })).resolves.toEqual(
        expect.objectContaining({ id: updated.id, name: 'Kin', color: null, order: 2 }),
      );
      expect(mocks.person.updateCategory).toHaveBeenCalledWith(auth.user.id, updated.id, {
        name: 'Kin',
        color: null,
        order: 2,
      });
    });

    it("answers 404 for a category that is missing or someone else's", async () => {
      const auth = AuthFactory.create();
      mocks.person.updateCategory.mockResolvedValue(undefined);

      await expect(sut.update(auth, newUuid(), { name: 'Kin' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('deletes only the category, leaving its people as they are', async () => {
      const auth = AuthFactory.create();
      const id = newUuid();
      mocks.person.deleteCategory.mockResolvedValue(true);

      await expect(sut.delete(auth, id)).resolves.toBeUndefined();
      expect(mocks.person.deleteCategory).toHaveBeenCalledWith(auth.user.id, id);
      expect(mocks.person.delete).not.toHaveBeenCalled();
      expect(mocks.person.update).not.toHaveBeenCalled();
    });

    it("answers 404 for a category that is missing or someone else's", async () => {
      const auth = AuthFactory.create();
      mocks.person.deleteCategory.mockResolvedValue(false);

      await expect(sut.delete(auth, newUuid())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setPersonCategories', () => {
    it("replaces the set of categories one of the caller's people is in", async () => {
      const auth = AuthFactory.create();
      const personGroupId = newUuid();
      const [first, second] = [newUuid(), newUuid()];
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([personGroupId]));
      mocks.person.getByGroupId.mockResolvedValue({ ownerId: auth.user.id, personGroupId } as any);
      mocks.person.getOwnCategoryIds.mockResolvedValue([first, second]);

      await expect(
        sut.setPersonCategories(auth, personGroupId, { categoryIds: [second, first, second] }),
      ).resolves.toEqual({ categoryIds: [first, second].toSorted() });

      expect(mocks.access.person.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([personGroupId]));
      expect(mocks.person.getByGroupId).toHaveBeenCalledWith({ ownerId: auth.user.id, personGroupId });
      expect(mocks.person.getOwnCategoryIds).toHaveBeenCalledWith(auth.user.id, [second, first]);
      expect(mocks.person.setPersonCategories).toHaveBeenCalledWith({ ownerId: auth.user.id, personGroupId }, [
        second,
        first,
      ]);
    });

    it('takes the person out of every category with an empty list', async () => {
      const auth = AuthFactory.create();
      const personGroupId = newUuid();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([personGroupId]));
      mocks.person.getByGroupId.mockResolvedValue({ ownerId: auth.user.id, personGroupId } as any);
      mocks.person.getOwnCategoryIds.mockResolvedValue([]);

      await expect(sut.setPersonCategories(auth, personGroupId, { categoryIds: [] })).resolves.toEqual({
        categoryIds: [],
      });
      expect(mocks.person.setPersonCategories).toHaveBeenCalledWith({ ownerId: auth.user.id, personGroupId }, []);
    });

    it("refuses someone else's person, such as a partner's, with 404", async () => {
      const auth = AuthFactory.create();
      const personGroupId = newUuid();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.setPersonCategories(auth, personGroupId, { categoryIds: [newUuid()] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.person.setPersonCategories).not.toHaveBeenCalled();
    });

    it('refuses a person the caller does not own even when access allows it', async () => {
      const auth = AuthFactory.create();
      const personGroupId = newUuid();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([personGroupId]));
      mocks.person.getByGroupId.mockResolvedValue(undefined);

      await expect(sut.setPersonCategories(auth, personGroupId, { categoryIds: [] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.person.setPersonCategories).not.toHaveBeenCalled();
    });

    it("refuses a category that is not the caller's with 400", async () => {
      const auth = AuthFactory.create();
      const personGroupId = newUuid();
      const [own, foreign] = [newUuid(), newUuid()];
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([personGroupId]));
      mocks.person.getByGroupId.mockResolvedValue({ ownerId: auth.user.id, personGroupId } as any);
      mocks.person.getOwnCategoryIds.mockResolvedValue([own]);

      await expect(
        sut.setPersonCategories(auth, personGroupId, { categoryIds: [own, foreign] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.person.setPersonCategories).not.toHaveBeenCalled();
    });
  });
});
