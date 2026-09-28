/**
 * Why a video failed to play, told truthfully (FL-35).
 *
 * Browsers report a missing or unreachable file with the same "source not supported" code
 * as a container they cannot play, so the format is blamed only when the browser itself
 * rules the file's type out (`canPlayType` answered ''). A decode failure means the file
 * arrived and the browser could not decode it. Anything else is a plain load failure.
 */
export type VideoFailure = 'load' | 'decode' | 'format';

const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export const describeVideoFailure = (
  error: Pick<MediaError, 'code'> | null | undefined,
  canPlayType: CanPlayTypeResult,
): VideoFailure => {
  if (error?.code === MEDIA_ERR_DECODE) {
    return 'decode';
  }
  if (error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED && canPlayType === '') {
    return 'format';
  }
  return 'load';
};
