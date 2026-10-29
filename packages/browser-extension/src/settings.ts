import type { CaptureCatalogDto } from '@frameleaf/sdk';
import {
  CaptureFailure,
  sameBinding,
  normalizeServerAddress,
  type ServerBinding,
} from './api';
import { trustedStorage } from './platform';

type Connection = {
  version: 1;
  binding: ServerBinding;
  token?: string;
  status: 'connected' | 'needs-attention';
  catalog: CaptureCatalogDto | null;
};
export type ConnectionStatus = Omit<Connection, 'version' | 'token'>;
const key = 'frameleafConnectionV1';
let secured: Promise<void> | undefined;
export function initializeStorage() {
  return (secured ??= trustedStorage().setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  }));
}
async function read(): Promise<Connection | null> {
  await initializeStorage();
  const value = (await trustedStorage().get(key))[key] as
    Partial<Connection> | undefined;
  if (value === undefined) return null;
  const binding = value?.binding;
  const catalog = value?.catalog;
  if (
    value?.version !== 1 ||
    !binding ||
    !(['serverId', 'userId', 'origin', 'credentialId'] as const).every(
      (field) =>
        typeof binding[field] === 'string' && binding[field].length > 0,
    ) ||
    !['connected', 'needs-attention'].includes(value.status ?? '') ||
    (value.status === 'connected' &&
      (typeof value.token !== 'string' || !value.token)) ||
    !(
      catalog === null ||
      (catalog && Array.isArray(catalog.albums) && Array.isArray(catalog.tags))
    )
  )
    throw new CaptureFailure('credential');
  try {
    if (normalizeServerAddress(binding.origin, true) !== binding.origin)
      throw new Error();
  } catch {
    throw new CaptureFailure('credential');
  }
  return value as Connection;
}
export async function connectionStatus(): Promise<ConnectionStatus | null> {
  const value = await read();
  return value
    ? { binding: value.binding, status: value.status, catalog: value.catalog }
    : null;
}
// Only the background's serialized trusted-message handler writes settings.
export async function saveConnection(binding: ServerBinding, token: string) {
  await initializeStorage();
  await trustedStorage().set({
    [key]: {
      version: 1,
      binding,
      token,
      status: 'connected',
      catalog: null,
    } satisfies Connection,
  });
}
export async function credentialFor(binding: ServerBinding): Promise<string> {
  const value = await read();
  if (
    !value ||
    value.status !== 'connected' ||
    !value.token ||
    !sameBinding(value.binding, binding)
  )
    throw new CaptureFailure('credential');
  return value.token;
}
export async function saveCatalog(
  binding: ServerBinding,
  catalog: CaptureCatalogDto,
) {
  const value = await read();
  if (
    value &&
    value.status === 'connected' &&
    sameBinding(value.binding, binding)
  )
    await trustedStorage().set({ [key]: { ...value, catalog } });
}
export async function pauseConnection(binding: ServerBinding) {
  const value = await read();
  if (value && sameBinding(value.binding, binding))
    await trustedStorage().set({
      [key]: {
        version: 1,
        binding: value.binding,
        status: 'needs-attention',
        catalog: null,
      } satisfies Connection,
    });
}
export async function disconnect() {
  await initializeStorage();
  await trustedStorage().remove(key);
}
