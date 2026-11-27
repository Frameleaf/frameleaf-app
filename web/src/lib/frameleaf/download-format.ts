/**
 * Download formats (FL-826, after the approved prototype's `DownloadFormatDialog`): photos download
 * as the original, a full-size JPEG or a web-size JPEG; videos always as the original. Every
 * download asks, starting on the account's default, except through a link its owner limited to web
 * size, where the server sends web size whatever is asked.
 */
import { DownloadFormat, type DownloadInfoDto } from '@frameleaf/sdk';
import { modalManager } from '@frameleaf/ui';
import DownloadFormatDialog from '$lib/components/frameleaf/DownloadFormatDialog.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getSharedLink } from '$lib/utils';

export const DOWNLOAD_FORMATS: readonly DownloadFormat[] = [
  DownloadFormat.Original,
  DownloadFormat.Jpeg,
  DownloadFormat.Web,
];

const isDownloadFormat = (value: unknown): value is DownloadFormat =>
  DOWNLOAD_FORMATS.includes(value as DownloadFormat);

/** The signed-in account's default; a visitor's, and one this page has never heard of, is Original. */
export const defaultDownloadFormat = (): DownloadFormat => {
  const saved = authManager.authenticated ? authManager.preferences.download.defaultFormat : undefined;
  return isDownloadFormat(saved) ? saved : DownloadFormat.Original;
};

/** The link being visited sends photos at web size only. */
export const linkIsWebSizeOnly = () => authManager.isSharedLink && !!getSharedLink()?.webSizeOnly;

/** A converted photo is a JPEG: `IMG_1.HEIC` saves as `IMG_1.jpg`; a JPEG keeps its name. */
export const convertedFileName = (name: string) =>
  /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^./\\]+$/, '')}.jpg`;

export type DownloadQuestion = {
  /** How many items, when known, for the title and the zip note. */
  count?: number;
  /** What to size: the same items the download asks for. Without it no sizes are shown. */
  info?: Pick<DownloadInfoDto, 'albumId' | 'assetIds' | 'userId'>;
  /** Says that videos stay original when a conversion is chosen. */
  hasVideo?: boolean;
};

/**
 * Asks which format to download in. Resolves to the format, or to nothing when the person
 * cancels. Through a link limited to web size nothing is asked and the answer is web size.
 */
export const askDownloadFormat = async (question: DownloadQuestion = {}): Promise<DownloadFormat | undefined> => {
  if (linkIsWebSizeOnly()) {
    return DownloadFormat.Web;
  }
  return modalManager.show(DownloadFormatDialog, { ...question, initial: defaultDownloadFormat() });
};
