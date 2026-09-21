import { toastManager } from '@immich/ui';
import { render } from '@testing-library/svelte';
import { fileUploadHandler } from '$lib/utils/file-uploader';
import Overlay from './DragAndDropUploadOverlay.svelte';

const { page } = vi.hoisted(() => ({
  page: {
    route: { id: '/(user)/locked/[[photos=photos]]/[[assetId=id]]' },
    params: {},
    url: new URL('https://example.test/locked'),
  },
}));
vi.mock('$app/state', () => ({ page }));
vi.mock('$lib/actions/shortcut', () => ({ shouldIgnoreEvent: () => false }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { isSharedLink: false } }));
vi.mock('$lib/utils/file-uploader', () => ({ fileUploadHandler: vi.fn() }));
vi.mock('@immich/ui', async (original) => ({
  ...(await original<typeof import('@immich/ui')>()),
  toastManager: { primary: vi.fn() },
}));

const pasteFile = () => {
  const event = new Event('paste');
  Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['synthetic'], 'example.jpg')] } });
  dispatchEvent(event);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('DataTransferItem', class {});
});
afterEach(() => vi.unstubAllGlobals());

it('does not upload or relocate files from the sensitive-only view', () => {
  page.url = new URL('https://example.test/locked');
  render(Overlay);
  pasteFile();
  expect(fileUploadHandler).not.toHaveBeenCalled();
  expect(toastManager.primary).toHaveBeenCalledWith('sensitive_upload_from_library');
});

it('retains legacy Locked uploading in the explicitly selected legacy view', () => {
  page.url = new URL('https://example.test/locked?view=legacy');
  render(Overlay);
  pasteFile();
  expect(fileUploadHandler).toHaveBeenCalledWith({
    files: [expect.any(File)],
    albumId: undefined,
    isLockedAssets: true,
  });
});
