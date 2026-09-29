export class ResourceBlockedError extends Error {
  code: 'FRAMELEAF_RESOURCE_BLOCKED';
  constructor(id: string);
}
export interface AdmittedResource {
  localRuntime: 'allowed';
  /** Digest of the reviewed row the owner approved (`studio/rights-approval.json`). */
  approvalSha256: string;
  /** Per-file byte digest, when one is recorded; null means byte verification fails closed. */
  sha256: string | null;
  locator: string | null;
  revision: string | null;
}
export function requireResource(id: string): AdmittedResource;
export function approvedRevision(id: string): string;
export function canUseResource(id: string): boolean;
export function verifyResourceBytes(id: string, bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
/** A Hugging Face URL for an approved repository, moved to the approved commit; others unchanged. */
export function pinnedHuggingFaceUrl(url: string): string;
