import { Controller, Get } from '@nestjs/common';
import { ApiResponse, DocumentBuilder, type OpenAPIObject, type SchemaObject, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { cleanupOpenApiDoc, createZodDto } from 'nestjs-zod';
import { createRequire } from 'node:module';
import z from 'zod';
import { removeOpenApi30IncompatibleKeys } from 'src/utils/misc.js';

const nested = z.object({ amount: z.number().meta({ format: 'double' }) }).meta({ id: 'UpgradeNested' });
const root = z
  .object({
    count: z.int().meta({ format: 'int32' }),
    nested,
    optional: z.string().optional(),
    nullable: z.string().nullable(),
  })
  .meta({ id: 'UpgradeRoot' });
class RootDto extends createZodDto(root) {}
const require = createRequire(import.meta.url);
const common = require('nestjs-zod') as typeof import('nestjs-zod');
const commonZod = require('zod') as typeof import('zod');

class CommonDto extends common.createZodDto(
  commonZod.z.object({ value: commonZod.z.string() }).meta({ id: 'UpgradeCommon' }),
) {}
type Recursive = { value: string; children: Recursive[] };
const recursive: z.ZodType<Recursive> = z
  .object({ value: z.string(), children: z.array(z.lazy(() => recursive)) })
  .meta({ id: 'UpgradeRecursive' });
class RecursiveDto extends createZodDto(recursive) {}
const tuple = z
  .object({
    point: z.tuple([z.number().meta({ format: 'double' }), z.number().meta({ format: 'double' })]),
    mixed: z.tuple([z.string(), z.int()]),
    referenced: z.tuple([nested, z.lazy(() => recursive)]),
  })
  .meta({ id: 'UpgradeTuple' });
class TupleDto extends createZodDto(tuple) {}

@Controller()
class UpgradeController {
  @Get('input') @ApiResponse({ type: RootDto }) input() {}
  @Get('output') @ApiResponse({ type: RootDto.Output }) output() {}
  @Get('common') @ApiResponse({ type: CommonDto }) common() {}
  @Get('recursive') @ApiResponse({ type: RecursiveDto }) recursive() {}
  @Get('tuple') @ApiResponse({ type: TupleDto }) tuple() {}
}

let document: OpenAPIObject;
beforeAll(async () => {
  const module = await Test.createTestingModule({ controllers: [UpgradeController] }).compile();
  const app = module.createNestApplication();
  try {
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Upgrade fixture').setVersion('1').build(),
    );
  } finally {
    await app.close();
  }
});

it.each(['UpgradeRoot', 'UpgradeRoot_Output'])(
  'preserves %s roots, nested refs, nullable values and numeric formats',
  (name) => {
    const result = cleanupOpenApiDoc(document);
    const schemas = result.components!.schemas!;
    const schema = schemas[name] as SchemaObject;
    expect(schema.properties!.count).toMatchObject({ type: 'integer', format: 'int32' });
    expect(schema.required).toEqual(expect.arrayContaining(['count', 'nested', 'nullable']));
    expect(schema.required).not.toContain('optional');
    expect(schema.properties!.nullable).toMatchObject({ type: 'string', nullable: true });
    expect(schema.properties!.nested).toHaveProperty('$ref', `#/components/schemas/${name.replace('Root', 'Nested')}`);
    expect(schemas[name.replace('Root', 'Nested')]).toMatchObject({
      properties: { amount: { type: 'number', format: 'double' } },
    });
  },
);

it('preserves CommonJS DTO generation', () => {
  expect(cleanupOpenApiDoc(document).components!.schemas!.UpgradeCommon).toMatchObject({
    properties: { value: { type: 'string' } },
    required: ['value'],
  });
});

it('preserves recursive references', () => {
  expect(cleanupOpenApiDoc(document).components!.schemas!.UpgradeRecursive).toMatchObject({
    properties: { children: { type: 'array', items: { $ref: '#/components/schemas/UpgradeRecursive' } } },
  });
});

it('still rejects conflicting component names', () => {
  const conflicting = structuredClone(document);
  const schema = structuredClone(conflicting.components!.schemas!.RootDto) as SchemaObject;
  schema.properties!.count = { ...schema.properties!.count, type: 'string' };
  conflicting.components!.schemas!.Conflict = schema;
  expect(() => cleanupOpenApiDoc(conflicting)).toThrow('multiple schemas');
});

it('preserves positional tuple constraints and references in OpenAPI 3.1', () => {
  const result = cleanupOpenApiDoc({ ...document, openapi: '3.1.0' });
  const tuple = result.components!.schemas!.UpgradeTuple as SchemaObject;
  expect(tuple.properties!.point).toMatchObject({
    type: 'array',
    prefixItems: [
      { type: 'number', format: 'double' },
      { type: 'number', format: 'double' },
    ],
    items: false,
    minItems: 2,
    maxItems: 2,
  });
  expect(tuple.properties!.mixed).toMatchObject({ prefixItems: [{ type: 'string' }, { type: 'integer' }] });
  expect(tuple.properties!.referenced).toMatchObject({
    prefixItems: [{ $ref: '#/components/schemas/UpgradeNested' }, { $ref: '#/components/schemas/UpgradeRecursive' }],
  });
});

it('normalizes homogeneous tuple schemas only at the application OpenAPI 3.0 boundary', () => {
  const result = cleanupOpenApiDoc(document);
  removeOpenApi30IncompatibleKeys(result);
  const tuple = result.components!.schemas!.UpgradeTuple as SchemaObject;
  expect(tuple.properties!.point).toMatchObject({
    type: 'array',
    items: { type: 'number', format: 'double' },
    minItems: 2,
    maxItems: 2,
  });
  expect(tuple.properties!.point).not.toHaveProperty('prefixItems');
});
