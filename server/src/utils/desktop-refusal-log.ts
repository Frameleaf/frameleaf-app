import { HttpException } from '@nestjs/common';

type Logger = { warn: (message: string) => void };

/**
 * Every refusal a desktop sees is also in the server log, at warn, with the device, the model key when it is
 * known and the code the desktop was given (docs/desktop-worker-setup-protocol.md in frameleaf-desktop).
 */
export const logDesktopRefusals = async <T>(
  logger: Logger,
  step: string,
  subject: () => string,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) {
      // The server's own reason, when it is a short code or sentence (never a validator's full report).
      const reason = error.cause instanceof Error ? error.cause.message : '';
      const cause = /^[\w .:-]{1,120}$/.test(reason) ? ` (${reason})` : '';
      logger.warn(`Desktop worker ${step} refused (${subject()}): ${error.getStatus()} ${error.message}${cause}`);
    }
    throw error;
  }
};

/** A reply that is a refusal without being an error: HTTP 200 with `accepted: false`. */
export const logDesktopNotAccepted = (logger: Logger, step: string, subject: string) =>
  logger.warn(`Desktop worker ${step} refused (${subject}): 200 accepted:false`);
