import { sameBinding, type ServerBinding } from './api';
import type { PageDiscovery } from './discovery';
export interface CapturePreview {
  id: string;
  binding: ServerBinding;
  discovery: PageDiscovery;
  createdAt: number;
}
// Previews are transient, not queued saves. A terminated worker requires another explicit scan.
let current: CapturePreview | null = null;
export function createPreview(
  binding: ServerBinding,
  discovery: PageDiscovery,
  now = Date.now(),
): CapturePreview {
  return (current = {
    id: crypto.randomUUID(),
    binding,
    discovery,
    createdAt: now,
  });
}
export function clearPreview() {
  current = null;
}
export function readPreview(
  id: string,
  binding: ServerBinding,
  now = Date.now(),
): CapturePreview | null {
  if (
    current &&
    (!sameBinding(binding, current.binding) ||
      now - current.createdAt >= 15 * 60 * 1000)
  )
    clearPreview();
  return current?.id === id ? current : null;
}

export function releaseCandidates(
  id: string,
  binding: ServerBinding,
  ids: string[],
): CapturePreview | null {
  const preview = readPreview(id, binding);
  if (preview) {
    const released = new Set(ids);
    preview.discovery.candidates = preview.discovery.candidates.filter(
      (candidate) => !released.has(candidate.id),
    );
  }
  return preview;
}
