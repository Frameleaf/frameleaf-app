import { parse } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { compileFunction } from 'node:vm';

// Exercise the route's actual callback without loading the editor's unrelated worker runtime.
const source = readFileSync(new NodeURL('./+page.svelte', import.meta.url), 'utf8');
const script = parse(source, { modern: true }).instance!.content;
const declaration = script.body
  .filter((node) => node.type === 'VariableDeclaration')
  .flatMap((node) => node.declarations)
  .find((node) => node.id.type === 'Identifier' && node.id.name === 'onSaveCopy')!;
const callback = declaration.init!;
if (
  !('start' in callback) ||
  typeof callback.start !== 'number' ||
  !('end' in callback) ||
  typeof callback.end !== 'number'
) {
  throw new Error('The Svelte parser must provide source locations for the Studio copy callback');
}
const expression = source.slice(callback.start, callback.end);
const bind = compileFunction(`return (${expression});`, [
  'session',
  '$t',
  'project',
  'Route',
  'libraryAssetIds',
  'data',
  'replaceState',
  'toastManager',
  'handleError',
]);

const setup = () => {
  const session = { saveAsCopy: vi.fn(async () => 'copy-id') };
  const route = { studio: vi.fn(() => '/studio?project=copy-id&assets=asset-id&restored=restored-id') };
  const replaceState = vi.fn(async () => {});
  const toast = { primary: vi.fn() };
  const error = vi.fn();
  const run = bind(
    session,
    (key: string) => key,
    { name: 'Original' },
    route,
    ['asset-id'],
    { restoredVersions: [{ restorationId: 'restored-id' }] },
    replaceState,
    toast,
    error,
  );
  return { run, route, replaceState, toast, error };
};

it('waits for the copy address update and preserves media query fields before reporting success', async () => {
  const test = setup();
  let finish!: () => void;
  test.replaceState.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = test.run();
  await vi.waitFor(() => expect(test.replaceState).toHaveBeenCalled());
  expect(test.route.studio).toHaveBeenCalledWith({
    projectId: 'copy-id',
    assetIds: ['asset-id'],
    restorationIds: ['restored-id'],
  });
  expect(test.replaceState).toHaveBeenCalledWith('/studio?project=copy-id&assets=asset-id&restored=restored-id', {});
  expect(test.toast.primary).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(test.toast.primary).toHaveBeenCalledWith('frameleaf_studio_copy_saved');
});

it('reports a refused address update through the existing save error path without a success toast', async () => {
  const test = setup();
  const failure = new Error('Navigation refused');
  test.replaceState.mockRejectedValue(failure);
  await test.run();
  expect(test.error).toHaveBeenCalledWith(failure, 'frameleaf_studio_save_failed');
  expect(test.toast.primary).not.toHaveBeenCalled();
});
