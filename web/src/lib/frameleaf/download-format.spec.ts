import { DownloadFormat } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askDownloadFormat,
  convertedFileName,
  defaultDownloadFormat,
  linkIsWebSizeOnly,
} from '$lib/frameleaf/download-format';

const auth = vi.hoisted(() => ({
  authenticated: true,
  isSharedLink: false,
  preferences: { download: { defaultFormat: 'jpeg' as string | undefined } },
}));
const link = vi.hoisted(() => ({ value: undefined as { webSizeOnly?: boolean } | undefined }));
const show = vi.hoisted(() => vi.fn());
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/utils', () => ({ getSharedLink: () => link.value }));
vi.mock('$lib/components/frameleaf/DownloadFormatDialog.svelte', () => ({ default: {} }));
vi.mock('@frameleaf/ui', () => ({ modalManager: { show } }));

describe('download formats (FL-826)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.authenticated = true;
    auth.isSharedLink = false;
    auth.preferences = { download: { defaultFormat: 'jpeg' } };
    link.value = undefined;
  });

  it('starts on the saved default, and on Original for a visitor or a format it has never heard of', () => {
    expect(defaultDownloadFormat()).toBe(DownloadFormat.Jpeg);
    auth.preferences = { download: { defaultFormat: 'tiff' } };
    expect(defaultDownloadFormat()).toBe(DownloadFormat.Original);
    auth.authenticated = false;
    expect(defaultDownloadFormat()).toBe(DownloadFormat.Original);
  });

  it('names a converted photo as a JPEG and leaves a JPEG alone', () => {
    expect(convertedFileName('IMG_1.HEIC')).toBe('IMG_1.jpg');
    expect(convertedFileName('trip.2026.cr3')).toBe('trip.2026.jpg');
    expect(convertedFileName('IMG_2.JPG')).toBe('IMG_2.JPG');
    expect(convertedFileName('scan')).toBe('scan.jpg');
  });

  it('asks, starting on the default, and passes the answer on', async () => {
    show.mockResolvedValue(DownloadFormat.Web);
    await expect(askDownloadFormat({ count: 3 })).resolves.toBe(DownloadFormat.Web);
    expect(show).toHaveBeenCalledWith(expect.anything(), { count: 3, initial: DownloadFormat.Jpeg });
  });

  it('does not ask through a link limited to web size', async () => {
    auth.isSharedLink = true;
    link.value = { webSizeOnly: true };
    expect(linkIsWebSizeOnly()).toBe(true);
    await expect(askDownloadFormat({ count: 3 })).resolves.toBe(DownloadFormat.Web);
    expect(show).not.toHaveBeenCalled();

    link.value = { webSizeOnly: false };
    expect(linkIsWebSizeOnly()).toBe(false);
  });
});
