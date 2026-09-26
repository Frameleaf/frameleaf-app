import {
  LibraryImportPathReason,
  LibraryScanPhase,
  MediaOperationStatus,
  UserStatus,
  type LibraryResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryFormDialog from '$lib/components/frameleaf/LibraryFormDialog.svelte';
import en from '../../../../../i18n/en.json';

const owners = [
  { id: 'owner-1', name: 'Taylor', status: UserStatus.Active, deletedAt: null },
  { id: 'owner-2', name: 'Jamie', status: UserStatus.Active, deletedAt: null },
] as never[];

const scanning = {
  operationId: 'op-1',
  status: MediaOperationStatus.Rendering,
  phase: LibraryScanPhase.Crawl,
  progress: 10,
  processedUnits: 5,
  totalUnits: 50,
  added: 0,
  checked: 0,
  updated: 0,
  offlined: 0,
  onlined: 0,
  pauseRequested: false,
  retrying: false,
  stopReason: null,
  errorCode: null,
  error: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
} as const;

const library = (overrides: Partial<LibraryResponseDto> = {}): LibraryResponseDto => ({
  id: 'lib-1',
  name: 'Family photo archive',
  ownerId: 'owner-1',
  importPaths: ['/mnt/photos'],
  exclusionPatterns: ['**/.DS_Store'],
  assetCount: 0,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  refreshedAt: null,
  deletedAt: null,
  scan: null,
  ...overrides,
});

const folderInput = (index: number) =>
  screen.getByLabelText(`${en.frameleaf_libraries_paths_import} ${index}`) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('LibraryFormDialog (FL-78)', () => {
  it('keeps the owner fixed while editing', () => {
    render(LibraryFormDialog, { library: library(), owners, onSaved: vi.fn(), onClose: vi.fn() });

    expect(screen.getByLabelText(en.frameleaf_libraries_field_owner)).toBeDisabled();
    expect(screen.getByText(en.frameleaf_libraries_owner_hint)).toBeInTheDocument();
  });

  it('says that saving new folders stops the running scan, then saves them', async () => {
    const onSaved = vi.fn();
    const current = library({ scan: { ...scanning } as never });
    sdkMock.updateLibrary.mockResolvedValue({ ...current, importPaths: ['/mnt/archive'] });
    render(LibraryFormDialog, { library: current, owners, onSaved, onClose: vi.fn() });

    expect(screen.queryByText(en.frameleaf_libraries_paths_while_scanning)).toBeNull();
    await fireEvent.input(folderInput(1), { target: { value: '/mnt/archive' } });
    expect(screen.getByText(en.frameleaf_libraries_paths_while_scanning)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_save }));

    expect(sdkMock.updateLibrary).toHaveBeenCalledWith({
      id: 'lib-1',
      updateLibraryDto: {
        name: 'Family photo archive',
        importPaths: ['/mnt/archive'],
        exclusionPatterns: ['**/.DS_Store'],
      },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows what the server says about each folder', async () => {
    sdkMock.validate.mockResolvedValue({
      importPaths: [
        { importPath: '/mnt/missing', isValid: false, reason: LibraryImportPathReason.NotFound },
        { importPath: '/mnt/secret', isValid: false, reason: LibraryImportPathReason.NotReadable },
      ],
    });
    render(LibraryFormDialog, {
      library: library({ importPaths: ['/mnt/missing', '/mnt/secret'] }),
      owners,
      onSaved: vi.fn(),
      onClose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_check_paths }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(en.frameleaf_libraries_reason_not_found);
    expect(status).toHaveTextContent(en.frameleaf_libraries_reason_not_readable);
    expect(status).toHaveTextContent(en.frameleaf_libraries_validation_footnote);
  });

  it('refuses a relative folder before asking the server', async () => {
    render(LibraryFormDialog, { owners, onSaved: vi.fn(), onClose: vi.fn() });

    await fireEvent.input(screen.getByLabelText(en.frameleaf_libraries_field_name), { target: { value: 'New' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_add_folder }));
    await fireEvent.input(folderInput(1), { target: { value: 'relative/path' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_create }));

    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_libraries_error_path_format);
    expect(sdkMock.createLibrary).not.toHaveBeenCalled();
  });

  it('creates a library for the chosen owner with the template’s default exclusion', async () => {
    sdkMock.createLibrary.mockResolvedValue(library());
    render(LibraryFormDialog, { owners, ownerId: 'owner-2', onSaved: vi.fn(), onClose: vi.fn() });

    await fireEvent.input(screen.getByLabelText(en.frameleaf_libraries_field_name), { target: { value: 'Trail cam' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_add_folder }));
    await fireEvent.input(folderInput(1), { target: { value: '/mnt/photos/jamie' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_create }));

    expect(sdkMock.createLibrary).toHaveBeenCalledWith({
      createLibraryDto: {
        ownerId: 'owner-2',
        name: 'Trail cam',
        importPaths: ['/mnt/photos/jamie'],
        exclusionPatterns: ['**/.DS_Store'],
      },
    });
  });
});
