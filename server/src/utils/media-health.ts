import { MediaHealthStatus } from 'src/enum.js';

const rawUnsupportedMessages = [
  'Input file has corrupt header',
  'Input buffer contains unsupported image format',
  'Unsupported file format or not RAW file',
  'unsupported image format',
  'no decode delegate',
];

// FL-1353: not "invalid". Decoders say it about odd but readable files ("Invalid SOS parameters"), and
// it is in the standard words for an unknown format. It is a suspicion, never confirmed damage.
const corruptMessages = ['corrupt', 'premature end', 'truncated', 'damaged'];

export const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isUnsupportedRawDecodeError = (error: unknown) => {
  const message = getErrorMessage(error);
  return rawUnsupportedMessages.some((item) => message.includes(item));
};

export const classifyImageDecodeFailure = (
  error: unknown,
  options: { isRaw: boolean; enhancedRawAttempted?: boolean },
): MediaHealthStatus => {
  const message = getErrorMessage(error).toLowerCase();

  if (options.isRaw && isUnsupportedRawDecodeError(error)) {
    return MediaHealthStatus.UnsupportedRaw;
  }

  if (corruptMessages.some((item) => message.includes(item))) {
    return options.isRaw ? MediaHealthStatus.CorruptSuspect : MediaHealthStatus.CorruptConfirmed;
  }

  return MediaHealthStatus.CorruptSuspect;
};
