import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import ICloudSync from './ICloudSync.svelte';

const mocks = vi.hoisted(() => ({
  authenticateICloudConnection: vi.fn(),
  controlICloudConnection: vi.fn(),
  createICloudConnection: vi.fn(),
  disconnectICloudConnection: vi.fn(),
  getAuthStatus: vi.fn(),
  getICloudInventory: vi.fn(),
  listICloudConnections: vi.fn(),
  updateICloudConnection: vi.fn(),
  goto: vi.fn(),
  handleError: vi.fn(),
}));

vi.mock('@immich/sdk', async (originalImport) => ({
  ...(await originalImport<typeof import('@immich/sdk')>()),
  ...mocks,
}));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://immich.example/utilities/icloud-sync') } }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: mocks.handleError }));
vi.mock('@immich/ui', async (originalImport) => ({
  ...(await originalImport<typeof import('@immich/ui')>()),
  toastManager: { primary: vi.fn() },
}));

const connection = (state = 'connected') => ({
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Personal photos',
  state,
  lastError: null,
  nextRunAt: null,
  counts: { logicalAssets: 10, resources: 12, imported: 8, failed: 1 },
  config: {
    libraries: [],
    albums: [],
    includeEdits: true,
    includeHidden: false,
    recoverExternalAsManaged: false,
    intervalHours: 24,
    concurrency: 1,
    stagingBytes: 20 * 1024 ** 3,
  },
});

describe('iCloud Photos Sync controls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps the connector unavailable until the server enables it', () => {
    render(ICloudSync, { initial: { enabled: false, connections: [] } });
    expect(screen.getByRole('status')).toHaveTextContent('icloud_sync.disabled');
    expect(screen.queryByRole('button', { name: 'icloud_sync.add_connection' })).not.toBeInTheDocument();
  });

  it('clears submitted passwords even when authentication fails and leaves external recovery off', async () => {
    mocks.authenticateICloudConnection.mockRejectedValue(new Error('reauthentication_required'));
    render(ICloudSync, { initial: { enabled: true, connections: [connection()] } });
    expect(screen.getByRole('checkbox', { name: /icloud_sync.external_recovery/ })).not.toBeChecked();
    const password = screen.getByLabelText('password', { exact: false });
    await fireEvent.input(screen.getByLabelText('icloud_sync.apple_id', { exact: false }), {
      target: { value: 'owner@example.com' },
    });
    await fireEvent.input(password, { target: { value: 'not-a-real-password' } });
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.sign_in' }));
    await waitFor(() =>
      expect(mocks.authenticateICloudConnection).toHaveBeenCalledWith({
        id: connection().id,
        iCloudAuthDto: { action: 'login', appleId: 'owner@example.com', password: 'not-a-real-password' },
      }),
    );
    expect(password).toHaveValue('');
    expect(mocks.handleError).toHaveBeenCalled();
    expect(mocks.controlICloudConnection).not.toHaveBeenCalled();
  });

  it('submits one verification or device approval request per user action', async () => {
    mocks.authenticateICloudConnection.mockResolvedValue(connection('awaiting-device-approval'));
    render(ICloudSync, { initial: { enabled: true, connections: [connection('awaiting-2fa')] } });
    await fireEvent.input(screen.getByLabelText('icloud_sync.verification_code', { exact: false }), {
      target: { value: '123456' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.verify' }));
    await waitFor(() =>
      expect(mocks.authenticateICloudConnection).toHaveBeenCalledWith({
        id: connection().id,
        iCloudAuthDto: { action: 'two-factor', code: '123456' },
      }),
    );
    await fireEvent.click(await screen.findByRole('button', { name: 'icloud_sync.check_approval' }));
    await waitFor(() => expect(mocks.authenticateICloudConnection).toHaveBeenCalledTimes(2));
    expect(mocks.authenticateICloudConnection).toHaveBeenLastCalledWith({
      id: connection().id,
      iCloudAuthDto: { action: 'device-approval' },
    });
  });

  it('saves exact source identities and explicit recovery consent without losing drafts during refresh', async () => {
    mocks.getICloudInventory.mockResolvedValue({
      complete: false,
      libraries: [{ id: 'library-key', name: 'Private library', supported: true }],
      albums: [{ id: 'library-key:album-id', libraryId: 'library-key', name: 'Vacation', parentId: null }],
    });
    mocks.listICloudConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...connection(), counts: { logicalAssets: 20, resources: 30 } }],
    });
    mocks.updateICloudConnection.mockResolvedValue(connection());
    render(ICloudSync, { initial: { enabled: true, connections: [connection()] } });
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.load_inventory' }));
    expect(await screen.findByText('icloud_sync.partial_inventory')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Private library' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Vacation/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /icloud_sync.external_recovery/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(mocks.listICloudConnections).toHaveBeenCalled());
    expect(screen.getByRole('checkbox', { name: /icloud_sync.external_recovery/ })).toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.updateICloudConnection).toHaveBeenCalledWith({
        id: connection().id,
        iCloudConnectionUpdateDto: {
          label: 'Personal photos',
          config: {
            ...connection().config,
            libraries: ['library-key'],
            albums: ['library-key:album-id'],
            recoverExternalAsManaged: true,
          },
        },
      }),
    );
  });

  it('allows removing unsupported selections but prevents adding them or their albums', async () => {
    const initialConnection = {
      ...connection(),
      config: { ...connection().config, libraries: ['supported', 'unsupported'], albums: ['selected-album'] },
    };
    mocks.getICloudInventory.mockResolvedValue({
      complete: true,
      libraries: [
        { id: 'supported', name: 'Supported library', supported: true },
        { id: 'unsupported', name: 'Unsupported library', supported: false },
        { id: 'unselected', name: 'Unavailable library', supported: false },
      ],
      albums: [
        { id: 'selected-album', libraryId: 'unsupported', name: 'Selected album', parentId: null },
        { id: 'new-album', libraryId: 'unsupported', name: 'Unavailable album', parentId: null },
      ],
    });
    mocks.updateICloudConnection.mockResolvedValue(connection());
    render(ICloudSync, { initial: { enabled: true, connections: [initialConnection] } });
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.load_inventory' }));
    const library = await screen.findByRole('checkbox', { name: /^Unsupported library/ });
    const album = screen.getByRole('checkbox', { name: /Selected album/ });
    expect(library).toBeEnabled();
    expect(album).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Unavailable library/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Unavailable album/ })).toBeDisabled();
    await fireEvent.click(library);
    expect(library).not.toBeChecked();
    expect(library).toBeDisabled();
    expect(album).toBeInTheDocument();
    await fireEvent.click(album);
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.updateICloudConnection).toHaveBeenCalledWith({
        id: connection().id,
        iCloudConnectionUpdateDto: {
          label: connection().label,
          config: { ...connection().config, libraries: ['supported'], albums: [] },
        },
      }),
    );
  });

  it('links verified recovery receipts to their existing asset and resolved health history', async () => {
    const assetId = '00000000-0000-4000-8000-000000000002';
    mocks.getICloudInventory.mockResolvedValue({
      libraries: [],
      albums: [],
      complete: true,
      recent: [{ assetId, resourceId: 'resource', outcome: 'repaired-missing' }],
    });
    render(ICloudSync, { initial: { enabled: true, connections: [connection()] } });
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.load_inventory' }));
    const link = await screen.findByRole('link', { name: /icloud_sync.view_asset/ });
    expect(link).toHaveAttribute('href', `/photos/${assetId}`);
    expect(screen.getByRole('link', { name: 'icloud_sync.resolved_missing' })).toHaveAttribute(
      'href',
      expect.stringContaining('resolved'),
    );
  });

  it('requires elevation for hidden imports and confirms disconnect without deleting media', async () => {
    mocks.getAuthStatus.mockResolvedValue({ isElevated: false });
    mocks.disconnectICloudConnection.mockResolvedValue(undefined);
    mocks.listICloudConnections.mockResolvedValue({ enabled: true, connections: [connection('disconnected')] });
    render(ICloudSync, { initial: { enabled: true, connections: [connection()] } });
    await fireEvent.click(screen.getByRole('checkbox', { name: /icloud_sync.include_hidden/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(mocks.goto).toHaveBeenCalledWith('/auth/pin-prompt?continue=%2Futilities%2Ficloud-sync'),
    );
    expect(mocks.updateICloudConnection).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.disconnect' }));
    expect(mocks.disconnectICloudConnection).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'icloud_sync.disconnect' }));
    await waitFor(() => expect(mocks.disconnectICloudConnection).toHaveBeenCalledWith({ id: connection().id }));
  });
});
