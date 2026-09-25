import { createPreservationPackage, previewPreservationExport, type PreservationPreviewResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { loadFilterPanelOptions, emptyFilterPanelOptions } from '$lib/frameleaf/search-options';
import en from '../../../../../i18n/en.json';
import PreservationExportDialog from './PreservationExportDialog.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  previewPreservationExport: vi.fn(),
  createPreservationPackage: vi.fn(),
  getAllAlbums: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/frameleaf/search-options', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/frameleaf/search-options')>()),
  loadFilterPanelOptions: vi.fn(),
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings') } }));

const previewOf = (overrides: Partial<PreservationPreviewResponseDto> = {}): PreservationPreviewResponseDto => ({
  items: 2,
  bytes: '2000',
  lockedItems: 0,
  lockedBytes: '0',
  includedItems: 2,
  includedBytes: '2000',
  maxItems: 100_000,
  withinLimit: true,
  lockedAllowed: false,
  freeBytes: '100000',
  support: [],
  ...overrides,
});

/**
 * FL-74 "select an authorized query": the export is asked for as a typed search compiled to the
 * server's filter, or as the selection bar's own items, and says what the server left out.
 */
describe('PreservationExportDialog', () => {
  beforeEach(() => {
    addMessages('dev', en);
    vi.mocked(previewPreservationExport).mockResolvedValue(previewOf());
    vi.mocked(loadFilterPanelOptions).mockResolvedValue({
      ...emptyFilterPanelOptions(),
      people: [{ id: 'p1', name: 'Jamie' }] as never,
    });
  });

  it('previews and exports a typed search as the server filter', async () => {
    render(PreservationExportDialog, { props: { open: true } });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_preservation_scope_search }));
    const field = screen.getByRole('searchbox', {
      name: new RegExp(`^${en.frameleaf_preservation_scope_search_label}`),
    });
    const continueButton = screen.getByRole('button', { name: en.continue });
    expect(continueButton).toBeDisabled();

    await vi.waitFor(() => expect(loadFilterPanelOptions).toHaveBeenCalled());
    await fireEvent.input(field, { target: { value: 'person:Jamie lake' } });
    const conditions = screen.getByRole('list', { name: en.frameleaf_preservation_scope_search_understood });
    expect(within(conditions).getByText('Jamie')).toBeInTheDocument();
    expect(within(conditions).getByText('Text: “lake”')).toBeInTheDocument();

    await fireEvent.click(continueButton);
    const filter = {
      personIds: { all: ['p1'] },
      or: [
        { originalFileName: { like: 'lake' } },
        { description: { like: 'lake' } },
        { ocr: { matches: 'lake' } },
        { originalPath: { like: 'lake' } },
      ],
    };
    expect(previewPreservationExport).toHaveBeenCalledWith({
      preservationPreviewDto: { scope: { filter }, includeLocked: false },
    });

    await fireEvent.click(await screen.findByRole('button', { name: en.continue }));
    vi.mocked(createPreservationPackage).mockResolvedValue({ id: 'package' } as never);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_preservation_start }));
    expect(createPreservationPackage).toHaveBeenCalledWith({
      preservationExportCreateDto: expect.objectContaining({ scope: { filter }, includeMetadata: true }),
    });
  });

  it('exports exactly the selected items and counts what was left out, before and after the check', async () => {
    vi.mocked(previewPreservationExport).mockResolvedValue(previewOf({ items: 2, includedItems: 2 }));
    render(PreservationExportDialog, {
      props: { open: true, selection: { assetIds: ['a', 'b', 'c'], leftOut: 1 } },
    });

    expect(screen.getByRole('button', { name: en.frameleaf_preservation_scope_selection })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('3 selected items of yours')).toBeInTheDocument();
    expect(screen.getByText('1 selected item belongs to someone else and is left out.')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.continue }));
    expect(previewPreservationExport).toHaveBeenCalledWith({
      preservationPreviewDto: { scope: { assetIds: ['a', 'b', 'c'] }, includeLocked: false },
    });
    expect(
      await screen.findByText('1 more could not be included: it is in the trash, no longer available or not yours.'),
    ).toBeInTheDocument();
  });

  it('shows checksums as always included, since every package carries them', () => {
    render(PreservationExportDialog, { props: { open: true } });
    const checksums = screen.getByRole('switch', { name: en.frameleaf_preservation_include_checksums });
    expect(checksums).toBeChecked();
    expect(checksums).toBeDisabled();
    expect(screen.getByText(en.frameleaf_preservation_always_protected)).toBeInTheDocument();
  });
});
