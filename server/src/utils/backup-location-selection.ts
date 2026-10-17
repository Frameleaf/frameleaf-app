import { lookup } from 'node:dns';
import { type RequestOptions, request } from 'node:https';
import { BlockList, type LookupFunction, isIP } from 'node:net';
import type { BackupLocation } from 'src/utils/frameleaf-cloud-backup.js';

const failure = () => new Error('No backup location could be reached reliably. Try setup again.');
const createProbeAddressLists = () => {
  const blocked = new BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    blocked.addSubnet(address, prefix, 'ipv4');
  }
  const publicV6 = new BlockList();
  publicV6.addSubnet('2000::', 3, 'ipv6');
  for (const [address, prefix] of [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
  ] as const) {
    blocked.addSubnet(address, prefix, 'ipv6');
  }
  return { blocked, publicV6 };
};
const { blocked, publicV6 } = createProbeAddressLists();

export const publicProbeAddress = (address: string): boolean => {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && publicV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
};

const probeUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      /^s3\.[a-z]{2}-[a-z]+-\d\.backup\.frameleaf\.cloud$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
      ? url
      : null;
  } catch {
    return null;
  }
};

// Resolve once, refuse mixed answers, and pin the validated address into this TLS connection.
const publicLookup: LookupFunction = (hostname, _options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || addresses.length === 0 || addresses.some(({ address }) => !publicProbeAddress(address))) {
      callback(new Error('Backup location did not resolve to public storage.'), '', 4);
      return;
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
};

/** No credentials, redirects, pooled connections, or untrusted certificate exceptions. */
export const probeBackupLocation = (location: BackupLocation, signal: AbortSignal): Promise<number | null> =>
  new Promise((resolve) => {
    const url = probeUrl(location.probeUrl);
    if (!url || signal.aborted) {
      resolve(null);
      return;
    }
    const started = performance.now();
    // HTTP typings omit this socket option; it is required to keep the validated DNS address pinned.
    const options: RequestOptions & { autoSelectFamily: false } = {
      method: 'HEAD',
      agent: false,
      autoSelectFamily: false,
      rejectUnauthorized: true,
      lookup: publicLookup,
      maxHeaderSize: 16_384,
      signal,
    };
    const req = request(url, options, (response) => {
      const status = response.statusCode ?? 0;
      resolve(status >= 200 && status < 500 ? performance.now() - started : null);
      response.resume();
    });
    req.once('error', () => resolve(null));
    req.end();
  });

type Probe = (location: BackupLocation, signal: AbortSignal) => Promise<number | null>;

const boundedProbe = async (location: BackupLocation, probe: Probe, overall: AbortSignal): Promise<number | null> => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  overall.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 1500);
  try {
    return await new Promise<number | null>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(null), { once: true });
      if (overall.aborted) {
        cancel();
        return;
      }
      Promise.try(() => probe(location, controller.signal))
        .then((value) => resolve(value !== null && Number.isFinite(value) && value >= 0 ? value : null))
        .catch(() => resolve(null));
    });
  } finally {
    clearTimeout(timeout);
    overall.removeEventListener('abort', cancel);
    controller.abort();
  }
};

/** Three samples per endpoint, six concurrent candidates, and a hard overall deadline. */
export const selectBackupLocation = async (
  locations: BackupLocation[],
  probe: Probe = probeBackupLocation,
): Promise<BackupLocation> => {
  if (
    locations.length === 0 ||
    locations.length > 16 ||
    new Set(locations.map(({ locationId }) => locationId)).size !== locations.length ||
    locations.some(({ locationId, probeUrl: url }) => !/^loc-\d{2}$/.test(locationId) || !probeUrl(url))
  ) {
    throw failure();
  }
  const overall = new AbortController();
  const deadline = setTimeout(() => overall.abort(), 15_000);
  const ranked: { location: BackupLocation; median: number }[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < locations.length && !overall.signal.aborted) {
      const location = locations[cursor++];
      const samples: number[] = [];
      for (let i = 0; i < 3 && !overall.signal.aborted; i++) {
        const result = await boundedProbe(location, probe, overall.signal);
        if (result !== null) {
          samples.push(result);
        }
      }
      if (samples.length >= 2) {
        samples.sort((a, b) => a - b);
        ranked.push({ location, median: samples.length === 2 ? (samples[0] + samples[1]) / 2 : samples[1] });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(6, locations.length) }, worker));
  } finally {
    clearTimeout(deadline);
    overall.abort();
  }
  ranked.sort(
    (a, b) =>
      a.median - b.median ||
      (a.location.locationId < b.location.locationId ? -1 : a.location.locationId > b.location.locationId ? 1 : 0),
  );
  if (!ranked[0]) {
    throw failure();
  }
  return ranked[0].location;
};
