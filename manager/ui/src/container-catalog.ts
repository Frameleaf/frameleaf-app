// FL-1476: what the Containers page knows. The variables Frameleaf reads (so settings are picked, not typed),
// the names Manager sets itself, suggestions for this server's hardware, and the checks run before saving.
// Names and defaults come from server/src and machine-learning/frameleaf_ml/config.py; RESERVED and the
// folder rules mirror manager/src/compose.ts.

export type ContainerId = 'frameleaf-server' | 'frameleaf-machine-learning' | 'database';
export type Purpose = 'library' | 'imports' | 'recovery' | 'other';
export type Mount = { source: string; target: string; readOnly: boolean; purpose: Purpose };
export type Draft = { environment: [string, string][]; mounts: Mount[]; memory: string; cpus: string };
export type ApiOverride = { environment?: Record<string, string>; mounts?: { source: string; target: string; readOnly: boolean }[]; memory?: string; cpus?: number };
export type Host = { cores: number; memoryGb: number; gpu: 'intel' | 'nvidia' | null };
type Entry = {
  name: string;
  legacy?: string;
  label: string;
  group: string;
  in: ContainerId[];
  type: 'choice' | 'switch' | 'number' | 'text' | 'folders';
  options?: string[];
  min?: number;
  max?: number;
  unit?: number;
  suffix?: string;
  placeholder?: string;
  default: string;
  about: string;
  warn?: string;
};

export const CONTAINERS: { id: ContainerId; label: string; icon: string; restart: string }[] = [
  { id: 'frameleaf-server', label: 'Frameleaf server', icon: 'server', restart: 'Photos pause for about a minute.' },
  { id: 'frameleaf-machine-learning', label: 'Machine learning', icon: 'cpu', restart: 'Faces and smart search pause while it restarts.' },
  { id: 'database', label: 'Database', icon: 'database', restart: 'Frameleaf stops until the database is back, usually under a minute.' },
];
export const GROUPS: Record<string, string> = {
  general: 'General', logs: 'Logs', speed: 'Speed and limits', folders: 'Folders and imports', icloud: 'iCloud',
  photos: 'Photos and videos', network: 'Network', monitoring: 'Monitoring', recovery: 'Recovery', models: 'Models', hardware: 'Graphics card',
};
const ZONES = ['America/Edmonton', 'America/Toronto', 'America/Vancouver', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Australia/Sydney', 'UTC'];
const ALL: ContainerId[] = ['frameleaf-server', 'frameleaf-machine-learning', 'database'];
const SERVER: ContainerId[] = ['frameleaf-server'];
const ML: ContainerId[] = ['frameleaf-machine-learning'];

export const CATALOG: Entry[] = [
  { name: 'TZ', label: 'Time zone', group: 'general', in: ALL, type: 'choice', options: ZONES, default: 'Set at setup', about: 'Dates in logs and the overnight schedule follow this.' },
  { name: 'FRAMELEAF_LOG_LEVEL', legacy: 'IMMICH_LOG_LEVEL', label: 'How much goes in the log', group: 'logs', in: [...SERVER, ...ML], type: 'choice', options: ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'], default: 'log', about: 'Turn up to debug when support asks; turn back down after, it fills the log quickly.' },
  { name: 'FRAMELEAF_LOG_FORMAT', legacy: 'IMMICH_LOG_FORMAT', label: 'Log format', group: 'logs', in: SERVER, type: 'choice', options: ['console', 'json'], default: 'console', about: 'JSON is for log collectors such as Loki or Graylog.' },
  { name: 'FRAMELEAF_LOG_REQUESTS', label: 'Log every request', group: 'logs', in: SERVER, type: 'switch', default: 'true', about: 'Off moves request lines to debug. Server errors are always logged.' },
  { name: 'FRAMELEAF_LOG_RETENTION_DAYS', label: 'Keep logs for', group: 'logs', in: SERVER, type: 'number', min: 1, max: 30, suffix: 'days', default: 'Automatic', about: 'Between 1 and 30 days.' },
  { name: 'FRAMELEAF_JOB_CAPACITY', label: 'Jobs at once', group: 'speed', in: SERVER, type: 'number', min: 1, max: 64, default: 'Automatic', about: 'How many background jobs run together. Wins over the setting in Frameleaf.' },
  { name: 'FRAMELEAF_SHARP_WORKERS', label: 'Thumbnail workers', group: 'speed', in: SERVER, type: 'number', min: 1, max: 8, default: '2', about: 'More makes thumbnails faster on a server with spare cores and memory.' },
  { name: 'FRAMELEAF_SHARP_MAX_PIXELS', label: 'Largest image to open', group: 'speed', in: SERVER, type: 'number', min: 1, max: 1000, unit: 1_000_000, suffix: 'megapixels', default: '200', about: 'Panoramas and scans over this are skipped instead of using all the memory.' },
  { name: 'FRAMELEAF_IMPORT_ROOTS', label: 'Folders imports can read', group: 'folders', in: SERVER, type: 'folders', placeholder: '/imports/takeout', default: 'None', about: 'Google Photos, iCloud and other imports from a folder on this server look here. Folders below marked “Imports” are added for you.' },
  { name: 'FRAMELEAF_RECOVERY_ROOTS', label: 'Folders to recover missing files from', group: 'folders', in: SERVER, type: 'folders', placeholder: '/old-library', default: 'None', about: 'Library care looks here for a good copy of a file that went missing or was damaged.' },
  { name: 'FRAMELEAF_ICLOUD_STAGING_PATH', legacy: 'IMMICH_ICLOUD_STAGING_PATH', label: 'iCloud download folder', group: 'icloud', in: SERVER, type: 'text', default: 'With your photos', about: 'Where iCloud files wait before they join the library. A fast drive helps.' },
  { name: 'FRAMELEAF_ICLOUD_MAX_CONCURRENCY', legacy: 'IMMICH_ICLOUD_MAX_CONCURRENCY', label: 'iCloud downloads at once', group: 'icloud', in: SERVER, type: 'number', min: 1, max: 16, default: '4', about: 'Lower it if iCloud slows your home internet.' },
  { name: 'FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', legacy: 'IMMICH_ICLOUD_MAX_STAGING_BYTES', label: 'iCloud download space', group: 'icloud', in: SERVER, type: 'number', min: 1, max: 4096, unit: 1024 ** 3, suffix: 'GB', default: '100', about: 'Downloads wait when this much is waiting to join the library.' },
  { name: 'FRAMELEAF_PROCESS_INVALID_IMAGES', legacy: 'IMMICH_PROCESS_INVALID_IMAGES', label: 'Try damaged images anyway', group: 'photos', in: SERVER, type: 'switch', default: 'false', about: 'Makes thumbnails from images that are partly damaged instead of skipping them.' },
  { name: 'FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS', legacy: 'IMMICH_MEDIA_VALIDATION_TIMEOUT_MS', label: 'Time to check a file', group: 'photos', in: SERVER, type: 'number', min: 10, max: 3600, unit: 1000, suffix: 'seconds', default: '120', about: 'Raise it for very large videos on a slow drive.' },
  { name: 'FRAMELEAF_RAW_RENDER_TIMEOUT_MS', label: 'Time to open a RAW photo', group: 'photos', in: SERVER, type: 'number', min: 10, max: 3600, unit: 1000, suffix: 'seconds', default: '120', about: 'Raise it for very large RAW files on a slow server.' },
  { name: 'FRAMELEAF_TRUSTED_PROXIES', legacy: 'IMMICH_TRUSTED_PROXIES', label: 'Reverse proxies to trust', group: 'network', in: SERVER, type: 'text', placeholder: '172.18.0.0/16', default: 'Private networks', about: 'Addresses of Nginx Proxy Manager, Caddy or Traefik, separated by commas.' },
  { name: 'FRAMELEAF_TRUSTED_LAN_CIDRS', label: 'Home networks', group: 'network', in: SERVER, type: 'text', placeholder: '192.168.1.0/24', default: 'Detected', about: 'Networks treated as at home, separated by commas. Remote access never is.' },
  { name: 'FRAMELEAF_METRICS_ENABLED', label: 'Prometheus metrics', group: 'monitoring', in: SERVER, type: 'switch', default: 'false', about: 'For Grafana and other dashboards.' },
  { name: 'FRAMELEAF_METRICS_PORT', label: 'Metrics port', group: 'monitoring', in: SERVER, type: 'number', min: 1, max: 65534, default: '8081', about: 'Inside the container. Only used while metrics are on.' },
  { name: 'FRAMELEAF_SHUTDOWN_GRACE_SECONDS', label: 'Time to finish work when stopping', group: 'recovery', in: SERVER, type: 'number', min: 5, max: 600, suffix: 'seconds', default: 'Automatic', about: 'How long running jobs get to finish before the container stops.' },
  { name: 'FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS', legacy: 'IMMICH_IGNORE_MOUNT_CHECK_ERRORS', label: 'Start even if folders look wrong', group: 'recovery', in: SERVER, type: 'switch', default: 'false', warn: 'Only while recovering a library. Frameleaf could start without your photos and think they were deleted.', about: 'Skips the check that your photo folders are there.' },
  { name: 'MACHINE_LEARNING_MODEL_TTL', label: 'Unload models after', group: 'models', in: ML, type: 'number', min: 0, max: 86400, suffix: 'seconds idle', default: '300', about: '0 keeps them loaded. Higher is faster, but keeps the memory in use.' },
  { name: 'MACHINE_LEARNING_MODEL_CACHE_MAX_ENTRIES', label: 'Models kept loaded', group: 'models', in: ML, type: 'number', min: 1, max: 128, default: '32', about: 'Lower it on a server with little memory.' },
  { name: 'MACHINE_LEARNING_WORKERS', label: 'Workers', group: 'speed', in: ML, type: 'number', min: 1, max: 8, default: '1', about: 'Each worker loads its own copy of the models.' },
  { name: 'MACHINE_LEARNING_REQUEST_THREADS', label: 'Requests at once', group: 'speed', in: ML, type: 'number', min: 1, max: 64, default: 'Number of cores', about: '' },
  { name: 'MACHINE_LEARNING_MODEL_INTRA_OP_THREADS', label: 'Threads per model', group: 'speed', in: ML, type: 'number', min: 0, max: 64, default: '0 (automatic)', about: '' },
  { name: 'MACHINE_LEARNING_TRANSCRIPTION_MAX_MEMORY_MB', label: 'Memory for video speech', group: 'speed', in: ML, type: 'number', min: 256, max: 65536, suffix: 'MB', default: '1536', about: 'Speech to text for video search.' },
  { name: 'MACHINE_LEARNING_DEVICE_IDS', label: 'Graphics cards to use', group: 'hardware', in: ML, type: 'text', placeholder: '0,1', default: 'All', about: 'Card numbers, separated by commas, when the server has more than one.' },
  { name: 'MACHINE_LEARNING_OPENVINO_PRECISION', label: 'Intel graphics precision', group: 'hardware', in: ML, type: 'choice', options: ['FP32', 'FP16'], default: 'FP32', about: 'FP16 is faster on Intel graphics, very slightly less exact.' },
  { name: 'MACHINE_LEARNING_SEMANTIC_MASK_DEVICE', label: 'Run Studio masks on', group: 'hardware', in: ML, type: 'choice', options: ['cpu', 'cuda', 'auto'], default: 'cpu', about: 'cuda needs an NVIDIA card.' },
  { name: 'MACHINE_LEARNING_MODEL_DOWNLOADS', label: 'Download models when needed', group: 'models', in: ML, type: 'switch', default: 'true', about: 'Off only if models are already in the model folder.' },
];
const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));
const BY_LEGACY = new Map(CATALOG.filter((entry) => entry.legacy).map((entry) => [entry.legacy!, entry]));
export const catalogEntry = (name: string) => BY_NAME.get(name);

/** Manager writes these; they're shown locked. Mirrors RESERVED_ENVIRONMENT, plus the FRAMELEAF_ forms it misses today. */
export const RESERVED = /^(DB_|POSTGRES_|FRAMELEAF_MANAGER_|IMMICH_CONFIG_FILE$|IMMICH_MEDIA_LOCATION$|FRAMELEAF_CONFIG_FILE$|FRAMELEAF_MEDIA_LOCATION$)/;
export const MANAGED_ENVIRONMENT: Record<ContainerId, [string, string, string][]> = {
  'frameleaf-server': [
    ['DB_HOSTNAME', 'database', 'Manager connects Frameleaf to its database.'],
    ['DB_PORT', '5432', ''],
    ['DB_USERNAME', 'frameleaf', ''],
    ['DB_DATABASE_NAME', 'frameleaf', ''],
    ['DB_PASSWORD_FILE', '/run/frameleaf/database-password', 'The password stays in a file only the containers can read.'],
    ['IMMICH_CONFIG_FILE', '/run/frameleaf/settings.json', ''],
    ['FRAMELEAF_MANAGER_URL', 'This Manager', 'How Frameleaf reaches Manager.'],
    ['FRAMELEAF_MANAGER_TOKEN_FILE', '/run/frameleaf/manager-token', ''],
  ],
  'frameleaf-machine-learning': [],
  database: [
    ['POSTGRES_USER', 'frameleaf', ''],
    ['POSTGRES_DB', 'frameleaf', ''],
    ['POSTGRES_PASSWORD_FILE', '/run/frameleaf/database-password', ''],
    ['POSTGRES_INITDB_ARGS', '--data-checksums', 'Damage in the database is caught early.'],
  ],
};

export type NameStatus = { status: 'empty' | 'invalid' | 'reserved' | 'known' | 'elsewhere' | 'legacy' | 'unknown'; message?: string; entry?: Entry; suggestion?: Entry };
/** What Manager knows about a variable name: a Frameleaf setting, an old name, one of Manager's own, or unknown. */
export function nameStatus(name: string, container: ContainerId): NameStatus {
  if (!name) return { status: 'empty', message: 'Give the variable a name.' };
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return { status: 'invalid', message: 'Capital letters, numbers and _ only, starting with a letter.' };
  if (RESERVED.test(name)) return { status: 'reserved', message: `Manager sets ${name} itself, so the stack keeps working after updates.` };
  const known = BY_NAME.get(name);
  if (known)
    return known.in.includes(container)
      ? { status: 'known', entry: known }
      : { status: 'elsewhere', entry: known, message: `${known.label} belongs to ${CONTAINERS.find((c) => known.in.includes(c.id))!.label}.` };
  const renamed = BY_LEGACY.get(name);
  if (renamed) return { status: 'legacy', entry: renamed, message: `Frameleaf now reads ${renamed.name}. The old name still works for now.` };
  const near = closest(name, container);
  if (near) return { status: 'unknown', suggestion: near, message: `Frameleaf doesn’t read ${name}. Did you mean ${near.name}?` };
  return { status: 'unknown', message: `Frameleaf doesn’t read ${name}. It’s passed to the container as it is.` };
}
function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}
// ponytail: edit distance over ~35 names; fine at this size.
function closest(name: string, container: ContainerId) {
  let best: { d: number; entry: Entry } | null = null;
  for (const entry of CATALOG.filter((e) => e.in.includes(container))) {
    const d = distance(name, entry.name);
    if (d <= 3 && (!best || d < best.d)) best = { d, entry };
  }
  return best?.entry ?? null;
}

/** A value its control can't hold: out of range, not a number, or a folder list with a relative path. */
export function valueIssue(name: string, value: string): string | null {
  const entry = BY_NAME.get(name);
  if (value.length > 4096) return 'Too long.';
  if (!entry) return null;
  if (entry.type === 'number') {
    if (!/^\d+(\.\d+)?$/.test(value)) return 'A number.';
    const shown = Number(value) / (entry.unit ?? 1);
    if (shown < entry.min! || shown > entry.max!) return `Between ${entry.min} and ${entry.max}${entry.suffix ? ` ${entry.suffix}` : ''}.`;
  }
  if (entry.type === 'folders' && value && value.split(/[,;]/).some((path) => !path.startsWith('/'))) return 'Folders inside the container, such as /imports/takeout.';
  return null;
}

/** Container path Manager suggests for a host folder: /external/<last part> or /imports/<last part>, made unique. */
export function suggestTarget(source: string, taken: string[], purpose: Purpose = 'library') {
  const base = (source.split('/').pop() || 'folder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'folder';
  const root = purpose === 'imports' ? '/imports' : purpose === 'recovery' ? '/recovery' : '/external';
  let target = `${root}/${base}`;
  for (let n = 2; taken.includes(target); n++) target = `${root}/${base}-${n}`;
  return target;
}

const RESERVED_TARGETS = ['/run/frameleaf', '/var/lib/postgresql', '/cache', '/data'];
const DENIED_SOURCES = ['/etc', '/proc', '/sys', '/dev', '/root', '/boot', '/run', '/var/run', '/var/lib/docker'];
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
/** Why a folder can't be added; null when it can. Manager's own check (checkServiceOverrides) still runs on save. */
export function mountIssue({ source, target }: { source: string; target: string }, others: { target: string }[]) {
  if (!source.startsWith('/')) return 'Choose a folder on this server.';
  if (source === '/' || source === '/mnt' || DENIED_SOURCES.some((denied) => under(source, denied)) || /appdata\/frameleaf-manager(\/|$)/.test(source))
    return 'Frameleaf never gets this folder: it holds the server’s own system or Manager’s settings.';
  if (!/^\/[^:\n]+$/.test(target) || target === '/') return 'A path inside the container, such as /external/archive.';
  if (RESERVED_TARGETS.some((reserved) => under(target, reserved))) return `${target} is one of Manager’s own folders. Pick another path.`;
  if (others.some((other) => other.target === target)) return `Another folder already uses ${target}.`;
  return null;
}

/** A folder's purpose that Frameleaf needs telling about: the variable it joins and that variable's separator. */
export const PURPOSE_VARIABLE: Partial<Record<Purpose, [string, string]>> = { imports: ['FRAMELEAF_IMPORT_ROOTS', ','], recovery: ['FRAMELEAF_RECOVERY_ROOTS', ';'] };
export const PURPOSES: Record<Purpose, string> = { library: 'Show in the library', imports: 'Imports', recovery: 'Recovering missing files', other: 'Something else' };

/** Stored settings → what the page edits. A folder listed in an import or recovery variable gets that purpose. */
export function fromApi(override: ApiOverride | undefined): Draft {
  const env = Object.entries(override?.environment ?? {}) as [string, string][];
  const mounts: Mount[] = (override?.mounts ?? []).map((m) => {
    const purpose = (Object.entries(PURPOSE_VARIABLE) as [Purpose, [string, string]][]).find(([, [variable, sep]]) =>
      (override?.environment?.[variable] ?? '').split(sep).includes(m.target),
    )?.[0];
    return { ...m, purpose: purpose ?? 'library' };
  });
  // The folder-derived part of a roots variable is shown on the folder, not typed in the variable.
  const environment = env
    .map(([name, value]): [string, string] => {
      const purpose = (Object.entries(PURPOSE_VARIABLE) as [Purpose, [string, string]][]).find(([, [variable]]) => variable === name);
      if (!purpose) return [name, value];
      const [p, [, sep]] = purpose;
      return [name, value.split(sep).filter((path) => path && !mounts.some((m) => m.purpose === p && m.target === path)).join(sep)];
    })
    .filter(([name, value]) => value !== '' || !Object.values(PURPOSE_VARIABLE).some(([variable]) => variable === name));
  return { environment, mounts, memory: override?.memory ?? '', cpus: override?.cpus ? String(override.cpus) : '' };
}

/** Folders marked "Imports" or "Recovering" join their variable, so nobody types it. */
export function effectiveEnvironment(draft: Draft): [string, string][] {
  let environment = draft.environment;
  for (const [purpose, [variable, separator]] of Object.entries(PURPOSE_VARIABLE) as [Purpose, [string, string]][]) {
    const targets = draft.mounts.filter((m) => m.purpose === purpose).map((m) => m.target);
    if (!targets.length) continue;
    const own = environment.find(([name]) => name === variable)?.[1];
    const roots = [...new Set([...(own ? own.split(separator) : []), ...targets])].join(separator);
    environment = [...environment.filter(([name]) => name !== variable), [variable, roots]];
  }
  return environment;
}

/** What the page edits → what POST container-settings takes. */
export function toApi(draft: Draft): ApiOverride {
  return {
    environment: Object.fromEntries(effectiveEnvironment(draft)),
    mounts: draft.mounts.map(({ source, target, readOnly }) => ({ source, target, readOnly })),
    ...(draft.memory && { memory: draft.memory }),
    ...(draft.cpus && { cpus: Number(draft.cpus) }),
  };
}

export const limitText = (limit: 'memory' | 'cpus', value: string) =>
  !value ? 'No limit' : limit === 'memory' ? `${value.replace(/g$/i, '')} GB` : `${value} ${Number(value) === 1 ? 'core' : 'cores'}`;

export type Change = { container: ContainerId; kind: 'add' | 'change' | 'remove'; what: string; from?: string; to?: string };
/** Every difference between what is running and the draft, and which containers restart. */
export function changes(saved: Record<ContainerId, Draft>, draft: Record<ContainerId, Draft>) {
  const list: Change[] = [];
  for (const { id } of CONTAINERS) {
    const a = saved[id];
    const b = draft[id];
    const before = new Map(effectiveEnvironment(a));
    const after = new Map(effectiveEnvironment(b));
    for (const [name, value] of after)
      if (!before.has(name)) list.push({ container: id, kind: 'add', what: name, to: value });
      else if (before.get(name) !== value) list.push({ container: id, kind: 'change', what: name, from: before.get(name), to: value });
    for (const [name, value] of before) if (!after.has(name)) list.push({ container: id, kind: 'remove', what: name, from: value });
    const key = (m: Mount) => `${m.source}→${m.target}`;
    const oldMounts = new Map(a.mounts.map((m) => [key(m), m]));
    const newMounts = new Map(b.mounts.map((m) => [key(m), m]));
    for (const [k, m] of newMounts)
      if (!oldMounts.has(k)) list.push({ container: id, kind: 'add', what: m.source, to: `${m.target}${m.readOnly ? ' · read-only' : ''}` });
      else if (oldMounts.get(k)!.readOnly !== m.readOnly)
        list.push({ container: id, kind: 'change', what: m.source, from: oldMounts.get(k)!.readOnly ? 'read-only' : 'read and write', to: m.readOnly ? 'read-only' : 'read and write' });
    for (const [k, m] of oldMounts) if (!newMounts.has(k)) list.push({ container: id, kind: 'remove', what: m.source, from: m.target });
    for (const limit of ['memory', 'cpus'] as const)
      if (a[limit] !== b[limit]) list.push({ container: id, kind: 'change', what: limit === 'memory' ? 'Memory limit' : 'Processor limit', from: limitText(limit, a[limit]), to: limitText(limit, b[limit]) });
  }
  return { list, restarts: CONTAINERS.filter((c) => list.some((change) => change.container === c.id)) };
}

/** KEY=VALUE lines for "Edit as text", and back. Manager's names and badly formed lines come back as errors. */
export const toText = (draft: Draft) => draft.environment.map(([name, value]) => `${name}=${value}`).join('\n');
export function fromText(text: string, container: ContainerId) {
  const environment: [string, string][] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = line.indexOf('=');
    const name = at < 0 ? line : line.slice(0, at).trim();
    const status = nameStatus(name, container);
    if (at < 0) errors.push(`Line ${i + 1}: NAME=value.`);
    else if (['invalid', 'reserved', 'empty'].includes(status.status)) errors.push(`Line ${i + 1}: ${status.message}`);
    else if (environment.some(([n]) => n === name)) errors.push(`Line ${i + 1}: ${name} is already set above.`);
    else environment.push([name, line.slice(at + 1)]);
  });
  return { environment, errors };
}

/** The dashboard's host facts in the page's terms. */
export function hostOf(host: { processors?: number; memory?: number; acceleration?: string } | undefined): Host | null {
  if (!host?.processors || !host.memory) return null;
  const gpu = host.acceleration === 'openvino' ? 'intel' : host.acceleration === 'cuda' ? 'nvidia' : null;
  return { cores: host.processors, memoryGb: Math.round(host.memory / 1024 ** 3), gpu };
}
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export type Suggestion = { name: string; shown: string; value: string; reason: string };
/**
 * What Manager would set for this server, per setting, and why. Only where the default doesn't fit the hardware.
 * ponytail: rules of thumb, not measurements; tune against a real library before shipping.
 */
export function suggestionsFor(host: Host, container: ContainerId): Suggestion[] {
  const list: Suggestion[] = [];
  const hostText = `${host.cores} cores and ${host.memoryGb} GB`;
  const add = (name: string, shown: string | number, reason: string) => {
    const entry = BY_NAME.get(name)!;
    if (!entry.in.includes(container) || String(shown) === entry.default) return;
    list.push({ name, shown: String(shown), value: String(entry.unit ? Number(shown) * entry.unit : shown), reason });
  };
  // About one thumbnail worker per 2 cores and per 4 GB, between 1 and 8.
  add('FRAMELEAF_SHARP_WORKERS', clamp(Math.min(Math.floor(host.cores / 2), Math.floor(host.memoryGb / 4)), 1, 8), `${hostText}: about one worker for every 2 cores and 4 GB.`);
  if (host.memoryGb <= 8) {
    add('FRAMELEAF_SHARP_MAX_PIXELS', 100, `${host.memoryGb} GB of memory: very large panoramas could use all of it.`);
    add('MACHINE_LEARNING_MODEL_CACHE_MAX_ENTRIES', 8, `${host.memoryGb} GB of memory: keep fewer models loaded at once.`);
    add('MACHINE_LEARNING_MODEL_TTL', 120, `${host.memoryGb} GB of memory: give it back sooner when nobody is searching.`);
  }
  if (host.memoryGb >= 32) add('MACHINE_LEARNING_MODEL_TTL', 1800, `${host.memoryGb} GB of memory: keeping models loaded makes search answer faster.`);
  if (host.gpu === 'intel') add('MACHINE_LEARNING_OPENVINO_PRECISION', 'FP16', 'Intel graphics found: FP16 is faster there.');
  if (host.gpu === 'nvidia') add('MACHINE_LEARNING_SEMANTIC_MASK_DEVICE', 'cuda', 'NVIDIA card found: Studio masks run on it.');
  return list;
}
/** Roughly how much memory a container needs with these settings, in GB. ponytail: estimates, measure before shipping. */
export function memoryNeedGb(container: ContainerId, draft: Draft) {
  const workers = Number(draft.environment.find(([n]) => n === 'FRAMELEAF_SHARP_WORKERS')?.[1] ?? 2);
  return container === 'frameleaf-server' ? 1.5 + 0.5 * workers : container === 'frameleaf-machine-learning' ? 3 : 1;
}
/** Limits that won't fit the settings or the server. Warnings; saving still works. */
export function limitIssues(container: ContainerId, draft: Draft, host: Host | null) {
  const issues: string[] = [];
  const memory = draft.memory ? Number(draft.memory.replace(/g$/i, '')) : null;
  const need = memoryNeedGb(container, draft);
  const label = CONTAINERS.find((c) => c.id === container)!.label;
  if (memory !== null && memory < need) issues.push(`${label} needs about ${need} GB with these settings, so ${memory} GB may stop it from starting.`);
  if (host && memory !== null && memory > host.memoryGb) issues.push(`This server only has ${host.memoryGb} GB.`);
  const workers = Number(draft.environment.find(([n]) => n === 'FRAMELEAF_SHARP_WORKERS')?.[1] ?? 2);
  if (container === 'frameleaf-server' && draft.cpus && Number(draft.cpus) < workers)
    issues.push(`${workers} thumbnail workers share ${draft.cpus} ${Number(draft.cpus) === 1 ? 'core' : 'cores'}, so they take turns. Fewer workers would do the same.`);
  if (host && draft.cpus && Number(draft.cpus) > host.cores) issues.push(`This server only has ${host.cores} cores.`);
  return issues;
}
/** A container's extra settings in a few words, for the Services list. */
export function summary(draft: Draft) {
  const parts: string[] = [];
  const env = effectiveEnvironment(draft).length;
  if (env) parts.push(`${env} ${env === 1 ? 'setting' : 'settings'}`);
  if (draft.mounts.length) parts.push(`${draft.mounts.length} ${draft.mounts.length === 1 ? 'folder' : 'folders'}`);
  if (draft.memory) parts.push(`${limitText('memory', draft.memory)} memory`);
  if (draft.cpus) parts.push(`${limitText('cpus', draft.cpus)}`);
  return parts.join(' · ');
}

/** Where a Manager-owned value can be changed instead: another Manager page, or an override on this one. */
export type ManagedChange = { page: 'storage' | 'updates' | 'settings' } | { override: string } | null;
export type ManagedRow = { name: string; label: string; value: string; why: string; change: ManagedChange; secretFile?: boolean };
export type ManagedMount = { target: string; source: string; readOnly: boolean; why: string; change: ManagedChange };
export type Fact = { label: string; value: string; why: string; change: ManagedChange };

const ENV_WHY: Record<string, [string, ManagedChange?]> = {
  DB_HOSTNAME: ['How Frameleaf finds its database.'],
  DB_PORT: ['How Frameleaf finds its database.'],
  DB_USERNAME: ['The database account Frameleaf uses.'],
  DB_DATABASE_NAME: ['The database Frameleaf uses.'],
  DB_PASSWORD_FILE: ['The database password, kept in a file only these containers can read. The password itself is never shown.'],
  POSTGRES_USER: ['The database account Frameleaf uses.'],
  POSTGRES_DB: ['The database Frameleaf uses.'],
  POSTGRES_PASSWORD_FILE: ['The database password, kept in a file only these containers can read. The password itself is never shown.'],
  POSTGRES_INITDB_ARGS: ['Damage in the database is caught early.'],
  FRAMELEAF_MANAGER_INSTALLATION: ['Which library this is, so Manager and Frameleaf recognise each other.'],
  FRAMELEAF_MANAGER_ORIGIN: ['How this library started: new, imported or restored.'],
  FRAMELEAF_MANAGER_IMPORT_INSTALLATION: ['The library this one was restored from.'],
  FRAMELEAF_MANAGER_TOKEN_FILE: ['Lets Frameleaf ask Manager for backups, updates and folder moves.'],
  FRAMELEAF_MANAGER_URL: ['Where Frameleaf reaches Manager.'],
  FRAMELEAF_MANAGER_ML_ENABLED: ['Whether machine learning was on when the library was set up.'],
  IMMICH_CONFIG_FILE: ['Frameleaf’s settings, in a file Manager writes.'],
  IMMICH_MEDIA_LOCATION: ['Where photos and videos are inside the container.', { page: 'storage' }],
  TZ: ['Chosen at setup.', { override: 'TZ' }],
  IMMICH_LOG_LEVEL: ['Chosen at setup.', { override: 'FRAMELEAF_LOG_LEVEL' }],
};
const ENV_LABEL: Record<string, string> = {
  DB_HOSTNAME: 'Database address', DB_PORT: 'Database port', DB_USERNAME: 'Database account', DB_DATABASE_NAME: 'Database name',
  DB_PASSWORD_FILE: 'Database password file', POSTGRES_USER: 'Database account', POSTGRES_DB: 'Database name',
  POSTGRES_PASSWORD_FILE: 'Database password file', POSTGRES_INITDB_ARGS: 'Database checksums',
  FRAMELEAF_MANAGER_INSTALLATION: 'Library ID', FRAMELEAF_MANAGER_ORIGIN: 'How the library started',
  FRAMELEAF_MANAGER_IMPORT_INSTALLATION: 'Restored from', FRAMELEAF_MANAGER_TOKEN_FILE: 'Manager access file',
  FRAMELEAF_MANAGER_URL: 'Manager address', FRAMELEAF_MANAGER_ML_ENABLED: 'Machine learning at setup',
  IMMICH_CONFIG_FILE: 'Settings file', IMMICH_MEDIA_LOCATION: 'Photos folder inside the container',
  TZ: 'Time zone', IMMICH_LOG_LEVEL: 'How much goes in the log',
};
const MOUNT_WHY: Record<string, [string, ManagedChange?]> = {
  '/data': ['Photos and videos.', { page: 'storage' }],
  '/var/lib/postgresql': ['The database.', { page: 'storage' }],
  '/cache': ['Downloaded models, kept between updates.'],
  '/run/frameleaf/manager-token': ['Lets Frameleaf ask Manager for backups, updates and folder moves.'],
  '/run/frameleaf/database-password': ['The database password file. Read-only.'],
  '/run/frameleaf/settings.json': ['Frameleaf’s settings file.'],
  '/run/frameleaf/studio-worker': ['Studio’s helper registration, shared between the server and machine learning.'],
};

type StackService = {
  image?: string;
  container_name?: string;
  environment?: Record<string, string>;
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[];
  ports?: { target: number; published: string; host_ip?: string }[];
  restart?: string;
  healthcheck?: { interval?: string };
  depends_on?: Record<string, unknown>;
  stop_grace_period?: string;
  shm_size?: string;
  command?: string[];
  devices?: string[];
  group_add?: string[];
  deploy?: { resources?: { reservations?: { devices?: { driver: string }[] } } };
};
const bytesText = (value: string) => value.replace(/^(\d+)\s*gb$/i, '$1 GB').replace(/^(\d+)\s*mb$/i, '$1 MB');

/**
 * What Manager itself puts in one container, read from the stack it last wrote (GET container-settings `stack`),
 * minus what the administrator added. Each value says what it is for and where it can be changed, if anywhere.
 */
export function managerView(service: StackService | undefined, mine: Draft, installationMounts: { target: string }[]) {
  const ownEnv = new Set(effectiveEnvironment(mine).map(([name]) => name));
  const ownMounts = new Set(mine.mounts.map((m) => m.target));
  const environment: ManagedRow[] = Object.entries(service?.environment ?? {})
    .filter(([name]) => !ownEnv.has(name))
    .map(([name, value]) => {
      const [why, change] = ENV_WHY[name] ?? ['Set by Manager.'];
      return { name, label: ENV_LABEL[name] ?? catalogEntry(name)?.label ?? name, value: String(value), why, change: change ?? null, secretFile: /PASSWORD_FILE$/.test(name) };
    });
  const mounts: ManagedMount[] = (service?.volumes ?? [])
    .filter((v) => !ownMounts.has(v.target))
    .map((v) => {
      const library = installationMounts.some((m) => m.target === v.target);
      const [why, change] = MOUNT_WHY[v.target] ?? (library ? ['Part of your library.', { page: 'storage' } as ManagedChange] : ['Set by Manager.']);
      return { target: v.target, source: v.type === 'volume' ? `Docker volume “${v.source}”` : v.source, readOnly: !!v.read_only, why, change: change ?? null };
    });
  const facts: Fact[] = [];
  if (service?.container_name) facts.push({ label: 'Container name', value: service.container_name, why: 'The name to use with docker logs or docker exec.', change: null });
  if (service?.image) {
    const [name, digest] = service.image.split('@');
    facts.push({ label: 'Image', value: digest ? `${name} @ ${digest.slice(0, 19)}…` : name, why: 'Checked against the signed release. Changes with each update.', change: { page: 'updates' } });
  }
  for (const port of service?.ports ?? [])
    facts.push({ label: 'Address', value: `${port.host_ip ?? '0.0.0.0'}:${port.published} → ${port.target}`, why: 'Where the Frameleaf app answers on this server.', change: { page: 'settings' } });
  if (service?.restart === 'unless-stopped') facts.push({ label: 'Restarts', value: 'After a crash or reboot', why: 'Unless you stop it here.', change: null });
  if (service?.depends_on) facts.push({ label: 'Starts after', value: Object.keys(service.depends_on).map((n) => (n === 'database' ? 'the database is ready' : n)).join(', '), why: '', change: null });
  if (service?.healthcheck?.interval) facts.push({ label: 'Health check', value: `Every ${service.healthcheck.interval.replace(/s$/, ' s')}`, why: 'Services shows Ready when it passes.', change: null });
  if (service?.stop_grace_period) facts.push({ label: 'Time to stop', value: service.stop_grace_period.replace(/s$/, ' s'), why: 'Running work gets this long to finish when the container stops.', change: null });
  if (service?.shm_size)
    facts.push({
      label: 'Shared memory',
      value: bytesText(service.shm_size),
      why: service.command ? 'Sized for this server’s memory.' : 'Locked files are opened in memory, never on disk.',
      change: null,
    });
  if (service?.command?.length)
    facts.push({
      label: 'Database tuning',
      value: service.command.filter((part) => part.includes('=')).join(' · '),
      why: 'Manager tunes the database for this server’s memory and redoes it after every start.',
      change: null,
    });
  const gpu = service?.deploy?.resources?.reservations?.devices?.length ? 'NVIDIA card' : service?.devices?.length ? service.devices.map((d) => d.split(':')[0]).join(', ') : '';
  if (gpu) facts.push({ label: 'Graphics card', value: gpu, why: 'Found at setup so machine learning can use it.', change: null });
  return { environment, mounts, facts };
}
