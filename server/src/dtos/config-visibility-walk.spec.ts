import z from 'zod';
import { stripVisibilityMetadata } from 'src/dtos/config.dto.js';

it('retains identity, object metadata and non-visibility leaf metadata through shared/defaulted sections', () => {
  const field = z.string().meta({ visibility: 'user', description: 'shared field', id: 'Field' });
  const section = z.object({ field });
  const root = z.object({ first: section, second: section.default({ field: '' }) }).meta({ visibility: 'admin' });
  expect(stripVisibilityMetadata(root)).toBe(root);
  expect(z.globalRegistry.get(field)).toEqual({ description: 'shared field', id: 'Field' });
  expect(z.globalRegistry.get(root)).toEqual({ visibility: 'admin' });
  expect(root.parse({ first: { field: 'value' } })).toEqual({ first: { field: 'value' }, second: { field: '' } });
});

it('walks deep schema declarations without exhausting the call stack', () => {
  const field = z.string().meta({ visibility: 'public', description: 'deep field' });
  let root: z.ZodType = field;
  for (let depth = 0; depth < 10_000; depth++) {
    root = z.object({ child: root });
  }
  expect(stripVisibilityMetadata(root)).toBe(root);
  expect(z.globalRegistry.get(field)).toEqual({ description: 'deep field' });
});

it('terminates on recursive object schemas and still visits their leaf fields', () => {
  const field = z.string().meta({ visibility: 'user', description: 'recursive field' });
  const root = z.object({
    get child() {
      return root;
    },
    field,
  });
  expect(stripVisibilityMetadata(root)).toBe(root);
  expect(z.globalRegistry.get(field)).toEqual({ description: 'recursive field' });
});

it('unwraps deep default chains while retaining the outer leaf metadata contract', () => {
  let root: z.ZodType = z.string();
  for (let depth = 0; depth < 10_000; depth++) {
    root = root.default('');
  }
  root = root.meta({ visibility: 'user', description: 'defaulted field' });
  expect(stripVisibilityMetadata(root)).toBe(root);
  expect(z.globalRegistry.get(root)).toEqual({ description: 'defaulted field' });
});
