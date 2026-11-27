import { mailSealKey, openMailSecret, sealMailSecret } from 'src/utils/frameleaf-mail.js';

/**
 * FL-1825: an optional Hugging Face access token for faster model downloads. AI models download from
 * Frameleaf's organisation on Hugging Face; with a key, downloads are less likely to be slowed down.
 *
 * The key is sealed at rest the way mail and import credentials are (AES-256-GCM under a key derived
 * from this server's own key file), with a purpose of its own. It is sent only to https://huggingface.co
 * (the check below) and to this server's own ML service, which itself sends it only to Hugging Face.
 */
export const MODEL_DOWNLOAD_KEY_SEAL_PURPOSE = 'model-download-key-seal';
const SEAL_CONTEXT = 'model-download-key';

/** The header the server passes the key to its own ML service in; empty means "no key". */
export const MODEL_DOWNLOAD_KEY_HEADER = 'x-frameleaf-model-download-key';

/** A Hugging Face user access token: `hf_` and letters and digits. */
export const MODEL_DOWNLOAD_KEY_PATTERN = /^hf_[A-Za-z0-9]{20,200}$/;

/** A saved key is checked with Hugging Face again when its page is opened and this long has passed. */
export const MODEL_DOWNLOAD_KEY_RECHECK_MS = 60 * 60 * 1000;

export const sealModelDownloadKey = (keyedHash: string, key: string) =>
  sealMailSecret(mailSealKey(keyedHash), SEAL_CONTEXT, key);

export const openModelDownloadKey = (keyedHash: string, sealed: string): string | null => {
  const key = openMailSecret<unknown>(mailSealKey(keyedHash), SEAL_CONTEXT, sealed);
  return typeof key === 'string' && MODEL_DOWNLOAD_KEY_PATTERN.test(key) ? key : null;
};

export type ModelDownloadKeyCheck = 'accepted' | 'refused' | 'unreachable';

/**
 * Ask Hugging Face whether it accepts the key: 200 accepted, 401 or 403 refused, anything else
 * (no network, a Hugging Face outage) unreachable. Nothing but the key goes in the request.
 */
export const checkModelDownloadKey = async (
  key: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<ModelDownloadKeyCheck> => {
  try {
    const response = await fetcher('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    if (response.ok) {
      return 'accepted';
    }
    return response.status === 401 || response.status === 403 ? 'refused' : 'unreachable';
  } catch {
    return 'unreachable';
  }
};
