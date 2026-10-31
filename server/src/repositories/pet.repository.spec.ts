import { PetObservationState } from 'src/enum.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('pet merge current durable decisions', () => {
  it.each([
    {
      label: 'new source decision',
      target: undefined,
      sourceState: PetObservationState.Confirmed,
      expected: 'reassign',
    },
    {
      label: 'confirmed source conflict',
      target: PetObservationState.Rejected,
      sourceState: PetObservationState.Confirmed,
      expected: 'promote',
    },
    {
      label: 'new rejection replaces old confirmation',
      target: PetObservationState.Rejected,
      sourceState: PetObservationState.Rejected,
      expected: 'discard',
    },
  ])('uses the $label under transaction locks', async ({ target, sourceState, expected }) => {
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('from "pet"')) return { rows: [{ id: 'source' }, { id: 'target' }] };
      if (sql.includes('from "pet_observation"'))
        return {
          rows: [
            { id: 'fresh-source', petId: 'source', assetId: 'asset', state: sourceState },
            ...(target ? [{ id: 'fresh-target', petId: 'target', assetId: 'asset', state: target }] : []),
          ],
        };
      return {};
    });
    try {
      // This plan was built before either of the current decisions above existed.
      const stale = { sourceId: 'source', targetId: 'target', reassign: [], promote: [], discard: [] };
      await new PetRepository(db, { setContext: vi.fn() } as never).mergeInto('owner', stale);
      const observationWrites = queries.filter(({ sql }) => /^(update|delete from) "pet_observation"/.test(sql));
      if (expected === 'reassign') {
        expect(observationWrites).toEqual([
          expect.objectContaining({
            sql: expect.stringContaining('set "petId" ='),
            parameters: expect.arrayContaining(['target', 'fresh-source']),
          }),
        ]);
      } else {
        expect(observationWrites).toContainEqual(
          expect.objectContaining({
            sql: expect.stringContaining('delete from "pet_observation"'),
            parameters: ['fresh-source'],
          }),
        );
        expect(observationWrites.some(({ sql }) => sql.startsWith('update'))).toBe(expected === 'promote');
      }
      const locks = queries.filter(({ sql }) => sql.endsWith('for update'));
      expect(locks).toHaveLength(2);
      expect(locks[0].sql).toContain('from "pet"');
      expect(locks[1].sql).toContain('from "pet_observation"');
      expect(queries.at(-1)?.sql).toBe('commit');
    } finally {
      await db.destroy();
    }
  });
});
