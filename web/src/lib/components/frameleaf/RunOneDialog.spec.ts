import { AssetTypeEnum } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import RunOneDialog from './RunOneDialog.svelte';

const asset = (id: string, originalFileName: string) =>
  ({ id, originalFileName, type: AssetTypeEnum.Image, exifInfo: { city: 'Banff' } }) as never;

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.searchAssets.mockResolvedValue({
    assets: { items: [asset('a1', 'IMG_1.jpg'), asset('a2', 'IMG_2.jpg')] },
  } as never);
});

it('lists recent photos, finds one by name and starts the work on the one picked', async () => {
  const onStart = vi.fn().mockResolvedValue(undefined);
  render(RunOneDialog, { open: true, title: 'Run on one item', verb: 'Start now', note: 'Pick one.', onStart });
  await screen.findByText('IMG_1.jpg');
  await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'IMG_2' } });
  await waitFor(() =>
    expect(sdkMock.searchAssets).toHaveBeenLastCalledWith({
      metadataSearchDto: expect.objectContaining({ originalFileName: 'IMG_2' }),
    }),
  );
  await fireEvent.click(screen.getByRole('radio', { name: /IMG_2.jpg/ }));
  await fireEvent.click(screen.getByRole('button', { name: 'Start now IMG_2.jpg' }));
  await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2' })));
});

it('looks a pasted ID up directly and shows why the work could not start', async () => {
  const onStart = vi.fn().mockRejectedValue(new Error('That task is turned off.'));
  render(RunOneDialog, { open: true, title: 'Run on one item', verb: 'Start now', note: 'Pick one.', onStart });
  const id = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
  await fireEvent.input(await screen.findByRole('searchbox'), { target: { value: `https://photos/x/${id}` } });
  await waitFor(() =>
    expect(sdkMock.searchAssets).toHaveBeenLastCalledWith({ metadataSearchDto: expect.objectContaining({ id }) }),
  );
  await fireEvent.click(screen.getByRole('radio', { name: /IMG_1.jpg/ }));
  await fireEvent.click(screen.getByRole('button', { name: 'Start now IMG_1.jpg' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That task is turned off.');
});
