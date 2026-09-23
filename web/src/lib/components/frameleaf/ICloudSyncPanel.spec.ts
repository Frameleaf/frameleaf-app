import { MediaOperationStatus, type ICloudConnectionResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import ICloudSyncPanel from './ICloudSyncPanel.svelte';

const mocks = vi.hoisted(() => ({
  authenticateICloudConnection: vi.fn(),
  controlICloudConnection: vi.fn(),
  createICloudConnection: vi.fn(),
  disconnectICloudConnection: vi.fn(),
  getAuthStatus: vi.fn(),
  getICloudInventory: vi.fn(),
  listICloudConnections: vi.fn(),
  removeICloudConnection: vi.fn(),
  updateICloudConnection: vi.fn(),
  goto: vi.fn(),
}));

vi.mock('@immich/sdk', async (originalImport) => ({
  ...(await originalImport<typeof import('@immich/sdk')>()),
  authenticateICloudConnection: mocks.authenticateICloudConnection,
  controlICloudConnection: mocks.controlICloudConnection,
  createICloudConnection: mocks.createICloudConnection,
  disconnectICloudConnection: mocks.disconnectICloudConnection,
  getAuthStatus: mocks.getAuthStatus,
  getICloudInventory: mocks.getICloudInventory,
  listICloudConnections: mocks.listICloudConnections,
  removeICloudConnection: mocks.removeICloudConnection,
  updateICloudConnection: mocks.updateICloudConnection,
}));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://frameleaf.example/utilities/icloud-sync') } }));

const id = '00000000-0000-4000-8000-000000000001';

const connection = (overrides: Partial<ICloudConnectionResponseDto> = {}): ICloudConnectionResponseDto => ({
  id,
  label: 'Personal iCloud',
  state: 'connected',
  authenticated: true,
  lastError: null,
  nextRunAt: null,
  counts: { imported: 128, reused: 42, 'needs-review': 3 },
  run: null,
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
  ...overrides,
});

const inventory = {
  complete: true,
  libraries: [{ id: 'personal', name: 'PrimarySync', area: 'private', supported: true }],
  albums: [{ id: 'personal:summer', libraryId: 'personal', name: 'Summer trip', parentId: null }],
  recent: [],
  review: [
    {
      resourceId: '00000000-0000-4000-8000-0000000000a1',
      kind: 'review',
      reason: 'live_photo_identity_conflict',
      fileName: 'IMG_1104.MOV',
      role: 'original',
      assetId: null,
    },
  ],
};

/** The header's connection button; the dialog's own submit can carry the same words. */
const openConnectionDialog = async (name: string) => {
  await fireEvent.click(screen.getAllByRole('button', { name })[0]);
};

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  addMessages('dev', en);
  authManager.setUser(userAdminFactory.build({ name: 'Taylor', isAdmin: false }));
  mocks.getICloudInventory.mockResolvedValue(inventory);
  mocks.goto.mockResolvedValue(undefined);
});

describe('ICloudSyncPanel', () => {
  it('stays unavailable until the server enables the connector', () => {
    render(ICloudSyncPanel, { initial: { enabled: false, connections: [] } });
    expect(screen.getByText(en.frameleaf_icloud_disabled_title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_icloud_add_connection })).toBeNull();
  });

  it('adds an independent, named connection from the empty state', async () => {
    mocks.createICloudConnection.mockResolvedValue(connection({ state: 'paused', authenticated: false }));
    render(ICloudSyncPanel, { initial: { enabled: true, connections: [] } });
    expect(screen.getByText(en.frameleaf_icloud_empty_title)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_icloud_add_connection }));
    await waitFor(() =>
      expect(mocks.createICloudConnection).toHaveBeenCalledWith({
        iCloudConnectionCreateDto: { label: 'iCloud connection 1' },
      }),
    );
  });

  it('clears the password as soon as it is sent, even when Apple refuses it', async () => {
    mocks.authenticateICloudConnection.mockRejectedValue(new Error('reauthentication_required'));
    render(ICloudSyncPanel, {
      initial: { enabled: true, connections: [connection({ state: 'paused', authenticated: false })] },
    });
    await openConnectionDialog(en.frameleaf_icloud_connect_account);
    const password = screen.getByLabelText(en.frameleaf_icloud_password);
    await fireEvent.input(screen.getByLabelText(en.frameleaf_icloud_apple_id), {
      target: { value: 'owner@example.com' },
    });
    await fireEvent.input(password, { target: { value: 'not-a-real-password' } });
    await fireEvent.submit(password.closest('form')!);
    await waitFor(() =>
      expect(mocks.authenticateICloudConnection).toHaveBeenCalledWith({
        id,
        iCloudAuthDto: { action: 'login', appleId: 'owner@example.com', password: 'not-a-real-password' },
      }),
    );
    expect(password).toHaveValue('');
    expect(mocks.controlICloudConnection).not.toHaveBeenCalled();
  });

  it('asks for a six-digit code and sends it once per click', async () => {
    mocks.authenticateICloudConnection.mockResolvedValue(connection({ state: 'awaiting-2fa' }));
    render(ICloudSyncPanel, { initial: { enabled: true, connections: [connection({ state: 'awaiting-2fa' })] } });
    await openConnectionDialog(en.frameleaf_icloud_connect_account);
    const verify = screen.getByRole('button', { name: en.frameleaf_icloud_verify });
    const code = screen.getByLabelText(en.frameleaf_icloud_code);
    await fireEvent.input(code, { target: { value: '1234' } });
    expect(verify).toBeDisabled();
    await fireEvent.input(code, { target: { value: '123456' } });
    await fireEvent.click(verify);
    await waitFor(() => expect(mocks.authenticateICloudConnection).toHaveBeenCalledTimes(1));
    expect(mocks.authenticateICloudConnection).toHaveBeenCalledWith({
      id,
      iCloudAuthDto: { action: 'two-factor', code: '123456' },
    });
    expect(code).toHaveValue('');
  });

  it('asks consent before hidden photos, then unlocks before saving', async () => {
    mocks.getAuthStatus.mockResolvedValue({ isElevated: false });
    render(ICloudSyncPanel, { initial: { enabled: true, connections: [connection()] } });
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_icloud_include_hidden }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_icloud_save }));
    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_icloud_consent_confirm }));
    await waitFor(() =>
      expect(mocks.goto).toHaveBeenCalledWith('/auth/pin-prompt?continue=%2Futilities%2Ficloud-sync'),
    );
    expect(mocks.updateICloudConnection).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem('frameleaf.icloud.pending-save')!)).toMatchObject({
      connectionId: id,
      draft: { includeHidden: true },
    });
  });

  it('brings the draft back after unlocking and saves it without asking consent twice', async () => {
    sessionStorage.setItem(
      'frameleaf.icloud.pending-save',
      JSON.stringify({ connectionId: id, draft: { label: 'Personal iCloud', includeHidden: true } }),
    );
    mocks.getAuthStatus.mockResolvedValue({ isElevated: true });
    mocks.updateICloudConnection.mockResolvedValue(connection());
    render(ICloudSyncPanel, { initial: { enabled: true, connections: [connection()] } });
    expect(screen.getByRole('checkbox', { name: en.frameleaf_icloud_include_hidden })).toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_icloud_save }));
    await waitFor(() => expect(mocks.updateICloudConnection).toHaveBeenCalled());
    expect(mocks.updateICloudConnection.mock.calls[0][0].iCloudConnectionUpdateDto.config.includeHidden).toBe(true);
    expect(sessionStorage.getItem('frameleaf.icloud.pending-save')).toBeNull();
  });

  it('controls the durable run it shows', async () => {
    mocks.controlICloudConnection.mockResolvedValue(connection());
    const running = connection({
      run: {
        id: '0195e2a0-0000-7000-8000-000000000001',
        status: MediaOperationStatus.Rendering,
        progress: 40,
        processedUnits: 4,
        totalUnits: 10,
        retrying: false,
        waiting: false,
        pauseRequested: false,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        createdAt: '2026-09-23T10:00:00.000Z',
      },
    });
    render(ICloudSyncPanel, { initial: { enabled: true, connections: [running] } });
    expect(screen.getByRole('button', { name: en.frameleaf_icloud_sync_now })).toBeDisabled();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_icloud_pause }));
    await waitFor(() =>
      expect(mocks.controlICloudConnection).toHaveBeenCalledWith({ id, iCloudControlDto: { action: 'pause' } }),
    );
  });

  it('lists reconciliation findings and sends a Live Photo pair to its review', async () => {
    render(ICloudSyncPanel, { initial: { enabled: true, connections: [connection()] } });
    expect(await screen.findByText('IMG_1104.MOV')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_icloud_reason_live_photo)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_icloud_review }));
    expect(mocks.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=live-photos');
  });

  it('removes a disconnected connection and says its photos stay', async () => {
    mocks.removeICloudConnection.mockResolvedValue(undefined);
    mocks.listICloudConnections.mockResolvedValue({ enabled: true, connections: [] });
    render(ICloudSyncPanel, {
      initial: { enabled: true, connections: [connection({ state: 'disconnected', authenticated: false })] },
    });
    await openConnectionDialog(en.frameleaf_icloud_connect_account);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_icloud_remove }));
    await waitFor(() => expect(mocks.removeICloudConnection).toHaveBeenCalledWith({ id }));
    expect(await screen.findByText(en.frameleaf_icloud_notice_removed)).toBeInTheDocument();
    expect(mocks.disconnectICloudConnection).not.toHaveBeenCalled();
  });
});
