/**
 * The Frameleaf mark (a rounded frame, the dot of the home server, a leaf growing out of the
 * frame's corner) as plain ASCII, printed once when the container starts. Kept in step with
 * `server/src/utils/banner.ts`.
 */
const MARK = [
  "   .--------------------.",
  String.raw`  /                      \ `,
  " |                  .-.  |",
  " |                  '-'  |",
  " |          _.--~~~~|    |   %NAME%",
  " |       .-'    _.-'|    |   %VERSION%",
  " |      /   _.-'    /    |",
  " |     / .-'      .'     |",
  String.raw`  \   |/ ____..--'  _____/`,
  "   '--'-'     '---'",
];

/** Green only on a terminal that allows colour; `docker logs` and pipes get plain text. */
export const renderBanner = (
  name: string,
  version: string,
  { color = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.MANAGER_RUNTIME !== 'native' } = {},
) => {
  const paint = (text: string) => (color ? `\u{1B}[32m${text}\u{1B}[39m` : text);
  return MARK.map((line) => paint(line.trimEnd()).replace('%NAME%', () => name).replace('%VERSION%', () => version)).join('\n');
};

/**
 * One console line. The native runtime answers its parent on stdout, so there every line goes to
 * stderr; in Docker both reach `docker logs`.
 */
export const print = (text: string) =>
  (process.env.MANAGER_RUNTIME === 'native' ? process.stderr : process.stdout).write(`${text}\n`);
export const log = (message: string) => print(`manager: ${message}`);

/** A Manager address as logged: IDs shown as `:id`, query values masked. */
export const requestLogPath = (url: string) => {
  const cut = url.search(/[?#]/);
  const path = (cut === -1 ? url : url.slice(0, cut))
    .split('/')
    .map((segment) => (/^(?=[^/]*\d)[\w.-]{20,}$/.test(segment) ? ':id' : segment))
    .join('/');
  if (cut === -1 || url[cut] === '#') return path;
  const names = [...new Set(new URLSearchParams(url.slice(cut + 1).split('#', 1)[0]).keys())];
  return names.length ? `${path}?${names.map((name) => `${encodeURIComponent(name)}=********`).join('&')}` : path;
};

/** Polled by the Manager UI every 10 seconds; a successful poll is never worth a line. */
const POLL_PATHS = new Set(['/manager-api/dashboard', '/manager-api/status']);

/**
 * One line per Manager API request: method, redacted path, status and duration. Cookies, headers and
 * bodies are never written. Static UI files are skipped.
 */
export const requestLog =
  (write: (message: string) => unknown = log) =>
  (req: { method: string; originalUrl: string }, res: NodeJS.EventEmitter & { statusCode: number; writableFinished: boolean }, next: () => void) => {
    const url = req.originalUrl;
    if (!url.startsWith('/manager-api/')) return next();
    const start = performance.now();
    res.once('close', () => {
      const path = url.split(/[?#]/, 1)[0];
      if (res.writableFinished && res.statusCode < 400 && POLL_PATHS.has(path)) return;
      const status = res.writableFinished ? res.statusCode : 'aborted';
      write(`${req.method} ${requestLogPath(url)} ${status} ${(performance.now() - start).toFixed(0)}ms`);
    });
    next();
  };

/** Time since `start` (ms epoch) as `850ms`, `12.3s` or `4m 05s`. */
export const elapsed = (start: number, now = Date.now()) => {
  const ms = now - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};
