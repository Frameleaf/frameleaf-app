import { PluginManifestMethodSchemaSchema } from 'src/dtos/plugin-manifest.dto.js';

it('keeps missing, null and empty method schemas compatible', () => {
  expect(PluginManifestMethodSchemaSchema.parse(undefined)).toBeUndefined();
  expect(PluginManifestMethodSchemaSchema.parse(null)).toBeNull();
  expect(PluginManifestMethodSchemaSchema.parse({})).toEqual({ type: 'object', precision: 1 });
});

it('preserves nested method schema constraints', () => {
  const schema = {
    type: 'object',
    properties: { count: { type: 'integer', title: 'Count', description: 'Count to process', minimum: 0 } },
    required: ['count'],
  };
  expect(PluginManifestMethodSchemaSchema.parse(schema)).toEqual({
    ...schema,
    precision: 1,
    properties: { count: { ...schema.properties.count, precision: 1 } },
  });
});

it.each([[], 1, 'object', { type: 'invalid' }, { properties: { count: { type: 'number' } } }])(
  'rejects an invalid schema %j',
  (schema) => expect(PluginManifestMethodSchemaSchema.safeParse(schema).success).toBe(false),
);
