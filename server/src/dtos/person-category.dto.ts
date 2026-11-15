import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { Selectable } from 'kysely';
import type { PersonCategoryTable } from 'src/schema/tables/person-category.table.js';
import { asDateTimeString } from 'src/utils/date.js';
import { hexColor } from 'src/validation.js';

/** FL-874: the longest category name. */
export const PERSON_CATEGORY_NAME_MAX_LENGTH = 100;
/** FL-874: how many categories one person can be put in at once. */
export const PERSON_CATEGORY_MAX_PER_PERSON = 100;

const name = z.string().trim().min(1).max(PERSON_CATEGORY_NAME_MAX_LENGTH);

const PersonCategoryCreateSchema = z
  .object({
    name: name.describe('Category name'),
    color: hexColor.nullable().optional().describe('Category color (hex)'),
  })
  .meta({ id: 'PersonCategoryCreateDto' });

const PersonCategoryUpdateSchema = z
  .object({
    name: name.optional().describe('Category name'),
    color: hexColor.nullable().optional().describe('Category color (hex); null clears it'),
    order: z.int().min(0).max(100_000).optional().describe('Position among the categories, lowest first'),
  })
  .refine((dto) => Object.values(dto).some((value) => value !== undefined), {
    message: 'At least one of name, color or order is required',
  })
  .meta({ id: 'PersonCategoryUpdateDto' });

const PersonCategoriesSetSchema = z
  .object({
    categoryIds: z
      .array(z.uuidv4())
      .max(PERSON_CATEGORY_MAX_PER_PERSON)
      .describe("The caller's categories the person is in from now on; an empty list takes them out of all"),
  })
  .meta({ id: 'PersonCategoriesSetDto' });

const PersonCategoryResponseSchema = z
  .object({
    id: z.uuidv4().describe('Category ID'),
    name: z.string().describe('Category name'),
    color: z.string().nullable().describe('Category color (hex)'),
    order: z.int().describe('Position among the categories, lowest first'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'PersonCategoryResponseDto' });

const PersonCategoriesResponseSchema = z
  .object({
    categoryIds: z.array(z.uuidv4()).describe("The caller's categories the person is in"),
  })
  .meta({ id: 'PersonCategoriesResponseDto' });

export class PersonCategoryCreateDto extends createZodDto(PersonCategoryCreateSchema) {}
export class PersonCategoryUpdateDto extends createZodDto(PersonCategoryUpdateSchema) {}
export class PersonCategoriesSetDto extends createZodDto(PersonCategoriesSetSchema) {}
export class PersonCategoryResponseDto extends createZodDto(PersonCategoryResponseSchema) {}
export class PersonCategoriesResponseDto extends createZodDto(PersonCategoriesResponseSchema) {}

export type PersonCategory = Selectable<PersonCategoryTable>;

export const mapPersonCategory = (category: PersonCategory): PersonCategoryResponseDto => ({
  id: category.id,
  name: category.name,
  color: category.color,
  order: category.order,
  createdAt: asDateTimeString(category.createdAt),
  updatedAt: asDateTimeString(category.updatedAt),
});
