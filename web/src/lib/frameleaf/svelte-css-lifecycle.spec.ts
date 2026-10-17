import { compile } from 'svelte/compiler';
import type { Plugin } from 'vite';
import config from '../../../vite.config';

const plugin = config.plugins?.find(
  (candidate): candidate is Plugin =>
    !!candidate &&
    typeof candidate === 'object' &&
    'name' in candidate &&
    candidate.name === 'frameleaf-svelte-css-cache',
);

const compiled = (global = false) =>
  compile(`<p>Album</p><style>${global ? ':global(body)' : 'p'} { color: red; }</style>`, {
    filename: '/fixture/Form.svelte',
    generate: 'client',
    css: 'external',
  });

const invoke = (
  hook: Plugin['transform'] | Plugin['load'] | Plugin['configResolved'],
  context: object,
  ...args: unknown[]
) => {
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  return handler ? Reflect.apply(handler, context, args) : undefined;
};

const compilerFixture = (global = false) => {
  const result = compiled(global);
  const output = { ...result.js, meta: { svelte: { css: result.css } } };
  const handler = vi.fn().mockResolvedValue(output);
  const filter = { id: /\.svelte$/ };
  const compiler: Plugin = { name: 'vite-plugin-svelte:compile', transform: { filter, handler } };
  const context = { environment: {}, getModuleInfo: vi.fn().mockReturnValue(undefined) };
  invoke(plugin?.configResolved, {}, { plugins: [compiler] });
  return { result, output, handler, filter, compiler, context };
};

it('retains the compiler return even when parent metadata is already absent', async () => {
  const { result, output, handler, filter, compiler, context } = compilerFixture();
  const options = { ssr: false };
  expect(await invoke(compiler.transform, context, 'original source', '/fixture/Form.svelte', options)).toBe(output);
  expect(handler).toHaveBeenCalledWith('original source', '/fixture/Form.svelte', options);
  expect(handler.mock.contexts[0]).toBe(context);
  expect(typeof compiler.transform === 'object' && compiler.transform.filter).toBe(filter);
  const style = invoke(plugin?.load, context, '/fixture/Form.svelte?svelte&type=style&lang.css');
  expect(style?.code).toBe(result.css?.code);
  expect(style?.map).toEqual(result.css?.map);
  expect(style?.meta?.vite?.cssScopeTo).toEqual(['/fixture/Form.svelte', 'default']);
});

it('keeps compiled styles isolated between Vite environments', async () => {
  const { result, compiler, context } = compilerFixture();
  await invoke(compiler.transform, context, result.js.code, '/fixture/Form.svelte');
  expect(invoke(plugin?.load, { environment: {} }, '/fixture/Form.svelte?svelte&type=style&lang.css')).toBeUndefined();
  expect(invoke(plugin?.load, context, '/fixture/Form.svelte?svelte&type=style&lang.css')?.code).toBe(result.css?.code);
});

it('retires old styles when a component recompiles without a stylesheet', async () => {
  const { result, handler, compiler, context } = compilerFixture();
  await invoke(compiler.transform, context, result.js.code, '/fixture/Form.svelte');
  handler.mockResolvedValue({ code: 'new component without styles', meta: { svelte: { css: null } } });
  await invoke(compiler.transform, context, 'new component without styles', '/fixture/Form.svelte');
  expect(invoke(plugin?.load, context, '/fixture/Form.svelte?svelte&type=style&lang.css')).toBeUndefined();
});

it('preserves global CSS and leaves ordinary module requests to Vite', async () => {
  const { result, compiler, context } = compilerFixture(true);
  await invoke(compiler.transform, context, result.js.code, '/fixture/Form.svelte');
  const style = invoke(plugin?.load, context, '/fixture/Form.svelte?svelte&type=style&lang.css');
  expect(style?.code).toBe(result.css?.code);
  expect(style?.meta?.vite?.cssScopeTo).toBeUndefined();
  expect(invoke(plugin?.load, context, '/fixture/Form.svelte')).toBeUndefined();
  expect(invoke(plugin?.load, context, '/fixture/normal.css')).toBeUndefined();
});

it('normalizes versioned parent IDs without treating styles as components', async () => {
  const { result, handler, compiler, context } = compilerFixture();
  await invoke(compiler.transform, context, result.js.code, '/fixture/Form.svelte?v=123');
  handler.mockResolvedValue({ code: 'transformed stylesheet' });
  await invoke(compiler.transform, context, 'stylesheet', '/fixture/Form.svelte?svelte&type=style&lang.css');
  expect(invoke(plugin?.load, context, '/fixture/Form.svelte?svelte&type=style&lang.css')?.code).toBe(result.css?.code);
});
