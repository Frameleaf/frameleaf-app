// FL-1664: opens manager/ui with sample data, for design review. No Manager, Docker or network is involved.
//   node test/ui-preview.mjs [port]
// The page address picks the sample (read here from the Referer):
//   ?sb=off|on|running|warning|restoring   Server Backup's state (default on)
//   &ws=backup&page=folders|schedule|restore|activity|key|settings   open a Server Backup screen
//   &fresh=1   a server with no Frameleaf installed yet
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const port = Number(process.argv[2] ?? 5391);
const GB = 1024 ** 3;
const TB = 1024 ** 4;
// Times are relative to now so "Today, 2:14 am" stays true whenever the preview is opened.
const at = (daysAgo, hour, minute = 0) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

const installation = { id: 'a'.repeat(12), name: 'Family library', project: 'frameleaf-' + 'a'.repeat(12), release: 'frameleaf-v3.2.0-1', port: 2283, ml: false, origin: 'new', mounts: [{ type: 'bind', source: '/mnt/user/media/photos', target: '/data', readOnly: false }], databasePath: '/mnt/cache/appdata/frameleaf' };
const dashboard = (fresh) => ({
  csrf: 'sample',
  administrator: { name: 'Owner' },
  host: { name: 'home-server', platform: 'linux/amd64', version: '28.4', available: true, memory: 16 * GB, processors: 8, acceleration: 'openvino' },
  backupRoot: '/mnt/user/backups/frameleaf',
  storageRoots: ['/mnt/user/media', '/mnt/user'],
  databaseStorage: { suggestedPath: '/mnt/cache/appdata', roots: ['/mnt/cache/appdata'] },
  installation: fresh ? null : installation,
  operations: [],
  profile: null,
  onboardingFinished: !fresh,
  appUrl: 'http://home-server.local:2283',
  suggestedPort: 2283,
  installations: fresh ? [] : [{ name: 'Family library', current: true, appPort: 2283, running: true }],
  services: fresh
    ? []
    : [
        { id: 'b'.repeat(64), service: 'frameleaf-server', running: true, health: 'healthy' },
        { id: 'c'.repeat(64), service: 'database', running: true, health: 'healthy' },
      ],
  summary: fresh ? null : { assets: 24860, users: 4, albums: 126, databaseBytes: GB },
  librarySetup: null,
});
const storage = [
  { path: '/mnt/user/media/photos', uses: ['media'], device: '1', totalBytes: 4 * TB, freeBytes: 2 * TB, availableBytes: 2 * TB, lowOnSpace: false, measurable: true },
  { path: '/mnt/cache/appdata', uses: ['database'], device: '2', totalBytes: 500 * GB, freeBytes: 180 * GB, availableBytes: 180 * GB, lowOnSpace: false, measurable: true },
  { path: '/mnt/user/backups/frameleaf', uses: ['backups'], device: '3', totalBytes: 2 * TB, freeBytes: TB, availableBytes: TB, lowOnSpace: false, measurable: true },
];

const settings = {
  folders: ['/mnt/user/documents', '/mnt/user/appdata', '/mnt/user/shares/family'],
  exclusions: ['*.tmp', 'cache/', 'Cache/', '.Trash-*/', 'node_modules/'],
  schedule: { time: '02:00', stop: '07:00' },
  limitMbps: null,
  retention: { keepLast: 3, keepDays: 90, keepMonthly: 12 },
};
const ms = (daysAgo, hour, minute = 0) => Date.parse(at(daysAgo, hour, minute));
let runId = 100;
const ran = (kind, state, daysAgo, hour, minute, outcome, error = null, took = 14) => ({
  id: runId--,
  kind,
  trigger: kind === 'restore' ? 'you' : 'schedule',
  state,
  startedAt: ms(daysAgo, hour, minute) - took * 60_000,
  finishedAt: ms(daysAgo, hour, minute),
  outcome,
  error,
});
const backed = (storedBytes, files) => ({ kind: 'backup', files, bytes: 311 * GB, storedBytes, problems: 0 });
const runs = [
  ran('backup', 'done', 0, 2, 14, backed(1.8 * GB, 215_813)),
  ran('backup', 'done', 1, 2, 9, backed(640 * 1024 ** 2, 215_790), null, 9),
  ran('restore', 'done', 3, 16, 20, { kind: 'restore', files: 863, bytes: 1.1 * GB, movedAside: 2 }, null, 3),
  ran('backup', 'failed', 4, 2, 40, null, 'The storage could not be reached.', 40),
  ran('backup', 'done', 5, 2, 11, backed(2.4 * GB, 215_512), null, 19),
];
const on = {
  state: 'on',
  settings,
  key: { saved: true, savedAt: ms(3, 10) },
  folders: [
    { kind: 'manager', path: '/mnt/user/backups/frameleaf/frameleaf-database', files: 318, bytes: 2 * GB },
    { kind: 'folder', path: '/mnt/user/documents', files: 21_840, bytes: 38 * GB },
    { kind: 'folder', path: '/mnt/user/appdata', files: 184_210, bytes: 59 * GB },
    { kind: 'folder', path: '/mnt/user/shares/family', files: 9655, bytes: 212 * GB },
  ],
  running: null,
  last: { state: 'done', at: ms(0, 2, 14), error: null, completeAt: ms(0, 2, 14) },
  next: ms(-1, 2, 0),
  runs,
  snapshots: [0, 1, 2, 3, 5, 6, 7].map((days) => ({ key: `s/${String(40 - days).padStart(12, '0')}-0123456789abcdef`, time: at(days, 2, days ? 9 + days : 14) })),
};
const samples = {
  on,
  running: {
    ...on,
    running: { kind: 'backup', trigger: 'schedule', startedAt: Date.now() - 3 * 3_600_000, files: 91_204, bytes: 131 * GB, totalBytes: 311 * GB, bytesPerSecond: 4.75 * 1024 ** 2, secondsLeft: 9 * 3600 },
    last: null,
    runs: [],
    snapshots: [],
  },
  warning: {
    ...on,
    key: { saved: false, savedAt: null },
    last: { state: 'failed', at: ms(0, 2, 40), error: 'The storage could not be reached.', completeAt: ms(1, 2, 9) },
    runs: [{ ...runs[3], finishedAt: ms(0, 2, 40), startedAt: ms(0, 2, 0) }, ...runs.slice(1, 3)],
  },
  restoring: { ...on, running: { kind: 'restore', trigger: 'you', startedAt: Date.now() - 60_000, files: 412, bytes: 0.7 * GB, totalBytes: 0, bytesPerSecond: 0, secondsLeft: null } },
  off: { ...on, state: 'off', settings: { ...settings, folders: [] }, key: { saved: false, savedAt: null }, folders: [on.folders[0]].map(({ kind, path }) => ({ kind, path })), last: null, next: null, runs: [], snapshots: [] },
};
const tree = {
  '': [{ name: 'mnt', type: 'folder', bytes: 0, modified: 0 }],
  mnt: [{ name: 'user', type: 'folder', bytes: 0, modified: 0 }],
  'mnt/user': ['appdata', 'backups', 'documents', 'shares'].map((name) => ({ name, type: 'folder', bytes: 0, modified: 0 })),
  'mnt/user/documents': [
    { name: 'Household', type: 'folder', bytes: 0, modified: ms(9, 12) },
    { name: 'Receipts', type: 'folder', bytes: 0, modified: ms(3, 12) },
    { name: 'School', type: 'folder', bytes: 0, modified: ms(20, 12) },
    { name: 'House insurance.pdf', type: 'file', bytes: 2.4 * 1024 ** 2, modified: ms(40, 10, 5) },
    { name: 'Passwords export.kdbx', type: 'file', bytes: 310 * 1024, modified: ms(1, 21, 30) },
    { name: 'Tax 2025.xlsx', type: 'file', bytes: 84 * 1024, modified: ms(3, 15, 42) },
  ],
};

const api = (path, page, body) => {
  const fresh = page.get('fresh') === '1';
  const sample = samples[page.get('sb') ?? (fresh ? 'off' : 'on')] ?? on;
  if (path === 'status') return { claimed: true };
  if (path === 'dashboard') return dashboard(fresh);
  if (path === 'server-backup') return sample;
  if (path === 'server-backup-browse') return { path: body.path, entries: tree[body.path.join('/')] ?? [] };
  if (path === 'server-backup-first-key' || path === 'server-backup-key') return { key: '7c1e9a40b2d85f63e0a71c4d9b3f6e25a8d04c7f1b9e3a62d5f08c4b7e1a9d30' };
  if (path === 'server-backup-turn-on' || path === 'server-backup-run') return { ...on, ...samples.running, snapshots: [] };
  if (path.startsWith('server-backup-')) return sample;
  if (path === 'folders') return { path: '/mnt/user', parent: null, folders: ['appdata', 'documents', 'media', 'shares'].map((name) => ({ name, path: `/mnt/user/${name}` })), truncated: false };
  if (path === 'storage') return storage;
  if (path === 'backup-status' || path === 'backups') return { configured: true, unlocked: true, keyAvailable: true, snapshots: [{ id: 'd'.repeat(64), time: at(3, 14, 5) }, { id: 'e'.repeat(64), time: at(11, 9, 30) }] };
  if (path === 'releases') return [{ tag: 'frameleaf-v3.2.0-1', publishedAt: at(20, 1), notes: 'Current release' }];
  if (path === 'sources') return { sources: [], refused: [] };
  if (path === 'photo-app-sources') return { sources: [] };
  if (path === 'container-settings') return { services: {} };
  if (path === 'storage-usage') return { media: { path: '/mnt/user/media/photos', bytes: 1.85 * TB }, database: { path: '/mnt/cache/appdata', bytes: 12 * GB }, thumbnails: { path: '/mnt/user/media/photos/thumbs', own: false, missing: false, bytes: 86 * GB, files: 412880 }, drives: [], suggestions: { database: null, thumbs: null } };
  return {};
};

const server = await createServer({
  configFile: false,
  root,
  plugins: [
    svelte(),
    {
      name: 'manager-sample-api',
      configureServer(vite) {
        vite.middlewares.use('/manager-api', async (request, response) => {
          const page = new URL(request.headers.referer ?? 'http://localhost/').searchParams;
          const path = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean).at(-1);
          let sent = '';
          for await (const part of request) sent += part;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(api(path, page, sent ? JSON.parse(sent) : {})));
        });
      },
    },
  ],
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
console.log(`Manager preview with sample data: http://127.0.0.1:${port}/?ws=backup`);
