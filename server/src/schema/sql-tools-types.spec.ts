import { Generated, Int8, Timestamp } from '@frameleaf/sql-tools';
import { InsertType, Insertable, SelectType } from 'kysely';
import { expectTypeOf } from 'vitest';

// This boundary crosses the linked SQL-tools workspace. Missing Kysely dependencies
// there must not silently turn generated database columns into required `any` fields.
it('preserves Kysely column types across the SQL-tools workspace boundary', () => {
  expectTypeOf<InsertType<Generated<string>>>().toEqualTypeOf<string | undefined>();
  expectTypeOf<SelectType<Generated<string>>>().toEqualTypeOf<string>();
  expectTypeOf<InsertType<Generated<Timestamp>>>().toEqualTypeOf<Date | string | undefined>();
  expectTypeOf<SelectType<Generated<Timestamp>>>().toEqualTypeOf<Date>();
  expectTypeOf<SelectType<Int8>>().toEqualTypeOf<number>();
  expectTypeOf<Insertable<{ id: Generated<string>; createdAt: Generated<Timestamp>; name: string }>>().toEqualTypeOf<{
    id?: string;
    createdAt?: Date | string;
    name: string;
  }>();
});
