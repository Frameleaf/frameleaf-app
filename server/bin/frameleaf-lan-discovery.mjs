#!/usr/bin/env node
// The application stays on its private Docker bridge; only this metadata publisher uses host networking.
import { pathToFileURL } from 'node:url';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';

function announcement(ping, port) {
  if (
    !ping ||
    ping.res !== 'pong' ||
    ping.lanDiscovery !== true ||
    typeof ping.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,50}$/.test(ping.id) ||
    typeof ping.name !== 'string' ||
    !ping.name ||
    Buffer.byteLength(`name=${ping.name}`) > 255 ||
    typeof ping.linked !== 'boolean' ||
    !['needed', 'complete'].includes(ping.setup) ||
    !['available', 'unavailable'].includes(ping.cloud)
  )
    return null;
  return {
    name: `Frameleaf ${ping.id}`,
    host: `frameleaf-${ping.id}.local`,
    type: 'frameleaf',
    protocol: 'tcp',
    port,
    txt: {
      id: ping.id,
      name: ping.name,
      linked: String(ping.linked),
      setup: ping.setup,
      cloud: ping.cloud,
      scheme: 'http',
    },
  };
}

export class LanDiscoveryBridge {
  constructor(bonjour, address, request = fetch, hostAddress = async () => undefined) {
    this.bonjour = bonjour;
    this.hostAddress = hostAddress;
    const url = new URL(address);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/')
      throw new Error('Invalid discovery address');
    this.port = Number(url.port || 80);
    this.url = new URL('/api/server/ping', url);
    this.request = request;
    this.closed = false;
    this.signature = null;
    this.service = null;
  }

  async refresh() {
    let record = null;
    let address;
    try {
      const response = await this.request(this.url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (response.ok) record = announcement(await response.json(), this.port);
      if (record) address = await this.hostAddress();
    } catch {
      // Withdraw stale announcements when the server or host address is unavailable.
      record = null;
    }
    if (this.closed) return;
    const signature = record && JSON.stringify([record, address]);
    if (signature === this.signature) return;
    this.service?.stop();
    this.service = null;
    this.signature = null;
    if (record) {
      this.service = this.bonjour.publish(record);
      if (address) {
        // Bonjour otherwise adds every host interface, including unreachable Docker bridge addresses.
        const records = this.service.records.bind(this.service);
        this.service.records = () => records().filter((r) => !['A', 'AAAA'].includes(r.type) || r.data === address);
      }
      this.signature = signature;
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    // Send DNS-SD goodbye packets before closing the socket; never hold shutdown indefinitely.
    let destroyed = false;
    const close = () => {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timeout);
      this.bonjour.destroy();
    };
    const timeout = setTimeout(close, 1000).unref();
    this.bonjour.unpublishAll(close);
  }
}

async function hostAddress(address) {
  const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !host.startsWith('127.') && host !== '::1') return host;
  const socket = createSocket(host === '::1' ? 'udp6' : 'udp4');
  try {
    // UDP connect selects the host's route without transmitting a packet.
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(9, host === '::1' ? '2001:db8::1' : '192.0.2.1', resolve);
    });
    return socket.address().address;
  } finally {
    socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: Bonjour } = await import('bonjour-service');
  const address = process.env.FRAMELEAF_DISCOVERY_URL || 'http://127.0.0.1:2283';
  const bridge = new LanDiscoveryBridge(
    new Bonjour({}, () => console.error('LAN discovery socket error')),
    address,
    fetch,
    () => hostAddress(address),
  );
  const refresh = () => bridge.refresh().catch(() => console.error('LAN discovery publication failed'));
  const timer = setInterval(refresh, 30_000);
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      clearInterval(timer);
      bridge.stop();
    });
  await refresh();
}
