import { schemaFromCode } from '@frameleaf/sql-tools';
import { readdir } from 'node:fs/promises';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { ImmichDatabase } from 'src/schema/index.js';

it('registers every table model for schema capture and retains it in the desired catalog', async () => {
  const directory = new URL('tables/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'));
  const modules = await Promise.all(files.map((file) => import(new URL(file, directory).href)));
  const models = modules.flatMap((module) =>
    Object.values(module).flatMap((value) => (typeof value === 'function' ? [value.name] : [])),
  );
  expect(models.length).toBeGreaterThan(0);
  const registered = new Set(new ImmichDatabase().tables.map((model) => model.name));
  expect(models.filter((model) => !registered.has(model))).toEqual([]);

  // Importing every model above also exposes decorators from a class accidentally omitted from
  // the entry point. Compare that full inventory with the independently captured PostgreSQL catalog.
  const catalog = new Set(getFrameleafSchema().tables.map(({ name }) => name));
  expect(
    schemaFromCode()
      .tables.filter(({ name }) => !catalog.has(name))
      .map(({ name }) => name),
  ).toEqual([]);
});
