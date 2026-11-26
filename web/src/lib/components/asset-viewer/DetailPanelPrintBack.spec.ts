import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import DetailPanelPrintBack from '$lib/components/asset-viewer/DetailPanelPrintBack.svelte';
import { readPrintBack } from '$lib/services/print-back.service.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../i18n/en.json';

// the generated SDK does not have the print-back endpoints until it is regenerated
vi.mock('$lib/services/print-back.service.svelte', () => ({
  printBackChanges: { revision: 0 },
  readPrintBack: vi.fn(),
  setPrintBack: vi.fn(),
  openAddPrintBack: vi.fn(),
}));

const asset = assetFactory.build({ id: 'front' });
const read = vi.mocked(readPrintBack);
type Answer = Awaited<ReturnType<typeof readPrintBack>>;
const answer = (value: Partial<Answer>) =>
  ({ frontAssetId: 'front', backAssetId: null, text: null, canEdit: false, ...value }) as Answer;

describe('DetailPanelPrintBack', () => {
  beforeAll(() => addMessages('dev', en));

  it('shows the owner the back, its text and what they can do', async () => {
    read.mockResolvedValue(answer({ backAssetId: 'back', text: 'Bonfire night', canEdit: true }));
    render(DetailPanelPrintBack, { asset, isOwner: true });

    expect((await screen.findByTestId('print-back-text')).textContent).toBe('Bonfire night');
    expect(screen.getByRole('img').getAttribute('src')).toContain('back');
    for (const label of [
      en.frameleaf_print_back_correct,
      en.frameleaf_documents_copy_text,
      en.frameleaf_print_back_remove,
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('shows someone else only the text: no image and no controls', async () => {
    read.mockResolvedValue(answer({ text: 'Bonfire night' }));
    render(DetailPanelPrintBack, { asset, isOwner: false });

    await screen.findByTestId('print-back-text');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says so when nothing was read, without promising a way to type it', async () => {
    read.mockResolvedValue(answer({ backAssetId: 'back', canEdit: true }));
    render(DetailPanelPrintBack, { asset, isOwner: true });

    expect(await screen.findByText(en.frameleaf_print_back_no_text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.frameleaf_print_back_correct })).toBeNull();
  });

  it('offers the owner Add back of print', async () => {
    read.mockResolvedValue(answer({}));
    render(DetailPanelPrintBack, { asset, isOwner: true });

    expect(await screen.findByRole('button', { name: en.frameleaf_print_back_add })).toBeTruthy();
  });

  it('offers a viewer nothing when there is no back', async () => {
    read.mockResolvedValue(answer({}));
    const { container } = render(DetailPanelPrintBack, { asset, isOwner: false });

    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(container.querySelector('section')).toBeNull();
  });
});
