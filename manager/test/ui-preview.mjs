// FL-1664: opens manager/ui with sample data, for design review. No Manager, Docker or network is involved.
//   node test/ui-preview.mjs [port]
// The page address picks the sample (read here from the Referer):
//   ?sb=off|unlicensed|setup|on|running|warning|restoring   Server Backup's state (default on)
//   &ws=backup&page=folders|schedule|restore|activity|key|settings|restore-server   open a Server Backup screen
//   &step=1..4   the set-up step      &fresh=1   a server with no Frameleaf installed yet
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

const folders = [
  { kind: 'manager', label: 'Manager settings and photo recovery points', note: 'What Manager needs to bring Frameleaf back', state: 'included', bytes: 2 * GB, files: 318 },
  { kind: 'folder', path: '/mnt/user/documents', state: 'included', bytes: 38 * GB, files: 21840 },
  { kind: 'folder', path: '/mnt/user/appdata', state: 'included', bytes: 59 * GB, files: 184210 },
  { kind: 'folder', path: '/mnt/user/shares/family', state: 'included', bytes: 212 * GB, files: 9655 },
  { kind: 'photos', label: 'Frameleaf photo library', note: '/mnt/user/media/photos · already protected by Cloud Backup in Frameleaf. Adding it here stores it twice.', state: 'left-out', bytes: 1.85 * TB, files: 24860 },
];
const runs = [
  { result: 'ok', at: at(0, 2, 14), title: 'Backed up', detail: '1.8 GB new · 412 files changed · took 14 minutes' },
  { result: 'ok', at: at(1, 2, 9), title: 'Backed up', detail: '640 MB new · 96 files changed · took 9 minutes' },
  { result: 'check', at: at(2, 4, 0), title: 'Monthly check passed', detail: 'Every stored file could be read back.' },
  { result: 'restore', at: at(3, 16, 20), title: 'Restored 2 items', detail: 'Tax 2025.xlsx and Receipts, back where they were' },
  { result: 'failed', at: at(4, 2, 0), title: 'Backup didn’t finish', detail: 'Frameleaf Cloud couldn’t be reached for 40 minutes. The next run carried on.' },
  { result: 'ok', at: at(5, 2, 11), title: 'Backed up', detail: '2.4 GB new · 1,204 files changed · took 19 minutes' },
];
const on = {
  state: 'on',
  machine: { name: 'home-server', account: 'you@example.com' },
  key: { saved: true, savedOn: '14 November' },
  folders,
  exclusions: ['*.tmp', '*.log', 'cache/', 'Cache/', '.Trash-*/', 'node_modules/'],
  schedule: { time: '2:00 AM', stop: '7:00 AM', limit: null, keep: '90 days, then one a month for a year' },
  storage: { usedBytes: 412 * GB, planBytes: 1024 * GB, serverBytes: 311 * GB, photosBytes: 101 * GB },
  run: null,
  restore: null,
  last: { result: 'ok', at: at(0, 2, 14) },
  next: 'tonight at 2:00 AM',
  runs,
  snapshots: [0, 1, 2, 3, 5, 6, 7].map((days) => ({ id: `s${days}`, at: at(days, 2, days ? 9 + days : 14) })),
  browse: {
    path: ['This server', 'mnt', 'user', 'documents'],
    entries: [
      { type: 'folder', name: 'Household', files: 1240, bytes: 3.2 * GB },
      { type: 'folder', name: 'Receipts', files: 862, bytes: 1.1 * GB, selected: true },
      { type: 'folder', name: 'School', files: 418, bytes: 640 * 1024 ** 2 },
      { type: 'file', name: 'Tax 2025.xlsx', bytes: 84 * 1024, modified: at(3, 15, 42), versions: 4, selected: true },
      { type: 'file', name: 'House insurance.pdf', bytes: 2.4 * 1024 ** 2, modified: at(40, 10, 5), versions: 1 },
      { type: 'file', name: 'Passwords export.kdbx', bytes: 310 * 1024, modified: at(1, 21, 30), versions: 12 },
    ],
    versions: [
      { at: at(3, 2, 13), bytes: 84 * 1024 },
      { at: at(12, 2, 10), bytes: 81 * 1024 },
      { at: at(31, 2, 12), bytes: 77 * 1024 },
    ],
  },
  photos: { name: 'Family library', running: true },
};
const samples = {
  on,
  running: { ...on, run: { percent: 42, doneBytes: 131 * GB, totalBytes: 311 * GB, mbps: 38, left: '9 hours' }, last: null, runs: [] },
  warning: { ...on, key: { saved: false }, last: { result: 'failed', at: at(0, 2, 0), completeAt: at(1, 2, 9), message: 'Frameleaf Cloud couldn’t be reached for 40 minutes. The next run picks up where this one stopped.' }, runs: [{ ...runs[4], at: at(0, 2, 0) }, ...runs.slice(1, 4)] },
  restoring: { ...on, restore: { items: 2, percent: 64, doneBytes: 0.7 * GB, totalBytes: 1.1 * GB, target: '/mnt/user/documents' } },
  off: { state: 'off', requirements: { licence: true, plan: true }, machine: on.machine, folders, snapshots: on.snapshots },
  unlicensed: { state: 'off', requirements: { licence: false, plan: false }, machine: on.machine, folders, snapshots: on.snapshots },
};
const setup = (step) => ({ ...on, state: 'setup', setup: { step, code: 'KMQD-7T2P', key: 'FLRK-7Q2D-K9MX-4THP-W3NV-8RCB-J6YF-2GZA' } });

const api = (path, page) => {
  const fresh = page.get('fresh') === '1';
  if (path === 'status') return { claimed: true };
  if (path === 'dashboard') return dashboard(fresh);
  if (path === 'server-backup') {
    const sample = page.get('sb') ?? (fresh ? 'off' : 'on');
    return sample === 'setup' ? setup(Number(page.get('step') ?? 1)) : (samples[sample] ?? on);
  }
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
        vite.middlewares.use('/manager-api', (request, response) => {
          const page = new URL(request.headers.referer ?? 'http://localhost/').searchParams;
          const path = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean).at(-1);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(api(path, page)));
        });
      },
    },
  ],
  server: { port, strictPort: true, host: '127.0.0.1' },
});
await server.listen();
console.log(`Manager preview with sample data: http://127.0.0.1:${port}/?ws=backup`);
