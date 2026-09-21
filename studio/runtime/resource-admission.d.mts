export class ResourceBlockedError extends Error {
  code: 'FRAMELEAF_RESOURCE_BLOCKED';
  constructor(id: string);
}
export function requireResource(id: string): { localRuntime: 'allowed'; sha256: string };
export function canUseResource(id: string): boolean;
export function verifyResourceBytes(id: string, bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
