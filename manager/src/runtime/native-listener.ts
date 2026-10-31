import { Refusal } from '../contracts.js';

/** Native administration is local; do not resolve hostnames or expose the listener on the LAN. */
export function nativeListener(origin: string): { host: string; port: number } {
  try {
    const address = new URL(origin);
    const port = Number(address.port);
    if (
      address.protocol !== 'https:' ||
      address.origin !== origin ||
      !['127.0.0.1', '[::1]'].includes(address.hostname) ||
      address.username ||
      address.password ||
      address.pathname !== '/' ||
      address.search ||
      address.hash ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535
    )
      throw new Error();
    return { host: address.hostname === '[::1]' ? '::1' : '127.0.0.1', port };
  } catch {
    throw new Refusal('native_manager_origin_invalid');
  }
}
