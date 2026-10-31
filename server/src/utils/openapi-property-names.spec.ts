import { type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { useSwagger } from 'src/utils/misc.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
}));
vi.mock('nestjs-zod', async (importOriginal) => ({
  ...(await importOriginal<typeof import('nestjs-zod')>()),
  cleanupOpenApiDoc: (document: OpenAPIObject) => document,
}));

afterEach(() => vi.restoreAllMocks());

describe('published OpenAPI property names', () => {
  it('retains prototype-like names as own data at every sorted object level', () => {
    const document: OpenAPIObject = {
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
      paths: {},
      components: {
        schemas: JSON.parse(
          '{"__proto__":{"type":"object","properties":{"z":{"type":"string"},"__proto__":{"type":"string"},"constructor":{"type":"boolean"}}}}',
        ),
      },
    };
    vi.spyOn(SwaggerModule, 'createDocument').mockReturnValue(document);
    vi.spyOn(SwaggerModule, 'setup').mockImplementation(() => {});

    useSwagger({} as INestApplication, { write: true });

    const published = JSON.parse(vi.mocked(writeFileSync).mock.calls.at(-1)![1] as string);
    expect(Object.keys(published.components.schemas)).toEqual(['__proto__']);
    expect(Object.keys(published.components.schemas.__proto__.properties)).toEqual(['__proto__', 'constructor', 'z']);
    expect(published.components.schemas.__proto__.properties.__proto__).toEqual({ type: 'string' });
    expect(Object.getPrototypeOf(document.components!.schemas)).toBe(Object.prototype);
  });
});
