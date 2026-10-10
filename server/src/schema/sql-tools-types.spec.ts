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
  type Insert = Insertable<{ id: Generated<string>; createdAt: Generated<Timestamp>; name: string }>;
  // Compare the row shape rather than Kysely's internal intersection aliases.
  expectTypeOf<{ [Key in keyof Insert]: Insert[Key] }>().toEqualTypeOf<{
    id?: string;
    createdAt?: Date | string;
    name: string;
  }>();
});
