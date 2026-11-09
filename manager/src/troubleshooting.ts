import { statfs } from 'node:fs/promises';
import { RESERVED_TARGETS } from './compose.js';
import { redact, type Installation } from './contracts.js';
import type { Container, Docker } from './docker.js';

export type Check = { name: string; ok: boolean | null; detail: string };
export type Problem = { service: string; problem: string; hint: string; count: number; example: string };

const MEDIA = /\.(jpe?g|png|gif|heic|heif|hif|avif|webp|tiff?|bmp|dng|raw|arw|cr2|cr3|nef|nrw|orf|raf|rw2|pef|srw|x3f|3fr|iiq|mov|mp4|m4v|avi|mkv|webm|mts|m2ts|3gp|wmv|mpe?g|insv|xmp|psd)\b/i;
// Folders photos commonly live under; a path starting here is a library path even when it is not a mount.
const LIBRARY = String.raw`(?:[A-Za-z]:)?[\\/](?:data|photos?|pictures|media|mnt|share|shares|volume\d*|srv|home|Users|usr/src/app/upload|external|import|library|upload)`;
// Folder and file names hold spaces, so a library path runs on to the next delimiter, not the next space.
const REST = String.raw`[^\n"'\`<>|,;:()]*`;
const END = String.raw`(?=[\\/\s"'\`<>|,;:()]|$)`;
const PATH = /(?:[A-Za-z]:)?[\\/][^\s"'`<>|,;()[\]{}]+/g;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hidden = (path: string) => `[path]${path.match(MEDIA)?.[0] ?? ''}`;

/**
 * Hide where a library lives and what is in it, for a report someone posts publicly. Every mounted folder (host
 * and container side), anything under a usual photo folder, and every media file name becomes `[path]`,
 * `[path].jpg` or `[file].jpg`; e-mail addresses go too. Code paths (`/usr/src/app/server/dist/...`) stay, so stack
 * traces still help. Best effort: the owner still reads the report before posting it.
 * ponytail: over-redacts the rest of a line after a library path rather than risk a folder name. Lines are cut at
 * 2000 characters and the scans that look ahead for a media extension are bounded, so one long line stays cheap.
 */
export function redactPaths(text: string, roots: string[]): string {
  text = text.replace(/^(.{2000}).+$/gm, '$1 …[line shortened]');
  for (const root of [...new Set(roots.map((r) => r.replace(/[\\/]+$/, '')))].filter((r) => r.length > 1).sort((a, b) => b.length - a.length))
    text = text.replace(new RegExp(`${escape(root)}${END}${REST}`, 'gm'), hidden);
  return text
    .replace(/"[^"\n]*"|`[^`\n]*`|'[^'\n]*'/g, (quoted) => {
      const ext = quoted.match(MEDIA);
      return ext ? `${quoted[0]}[file]${ext[0]}${quoted[0]}` : quoted;
    })
    .replace(new RegExp(`${LIBRARY}${END}${REST}`, 'gim'), hidden)
    .replace(new RegExp(String.raw`(?:[A-Za-z]:)?[\\/][^\n"'\`<>|,;:()]{0,512}?${MEDIA.source}`, 'gi'), hidden)
    .replace(PATH, (path) => (MEDIA.test(path) ? `[file]${path.match(MEDIA)![0]}` : path))
    .replace(new RegExp(`[^\\s"'\`<>|,;:()[\\]{}=\\\\/]{1,255}${MEDIA.source}`, 'gi'), (_name, ext: string) => `[file].${ext}`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}

// Only the targets Manager reserves (extra folders may not use them) stay visible: they name no one. GPU devices
// reach containers as devices, not mounts, so /dev/dri still shows wherever a log mentions it. Every other mount a
// container has is hidden, including one left from an earlier container setting while a change is unresolved.
const reserved = (path: string) => RESERVED_TARGETS.some((target) => path === target || path.startsWith(`${target}/`));
/**
 * Folders to hide in a report. Configured ones (library mounts, extra folders, storage, backups, Manager state) are
 * always hidden; what Docker reports as mounted is hidden unless it is one of Manager's reserved targets above.
 */
export const redactionRoots = (configured: string[], containerMounts: string[]) =>
  [...configured, ...containerMounts.filter((path) => path && !reserved(path))].filter(Boolean);

// Docker's own failures come first: their lines also name a network or file error a later entry would claim.
// Wording follows the prototype's server checks (FL-1310) where it words the same problem.
const KNOWN: { problem: string; pattern: RegExp; hint: string }[] = [
  { problem: 'Port in use', pattern: /port is already allocated|address already in use|EADDRINUSE/i, hint: 'Another app on this server is already using the port Frameleaf would open on. Choose a different Frameleaf port, or stop the other app, then try again.' },
  { problem: 'Folder missing', pattern: /(?:bind|mount) source path does not exist/i, hint: 'A folder Frameleaf uses isn’t on this server any more. Check that its drive or share is connected and the folder wasn’t moved or renamed, then try again.' },
  { problem: 'Too many downloads', pattern: /toomanyrequests|pull rate limit|429 Too Many Requests/i, hint: 'Frameleaf’s download server is limiting downloads from this network for now. Wait an hour, then try again.' },
  { problem: 'Manager can’t reach Frameleaf’s downloads', pattern: /(?:pull|registry|ghcr\.io|docker\.io|\/v2\/|resolve reference)[^\n]*(?:no such host|i\/o timeout|connection refused|TLS handshake timeout|network is unreachable|connection reset|request canceled|Temporary failure in name resolution)/i, hint: 'This server couldn’t connect to ghcr.io, where Frameleaf is downloaded from. Check this server is connected to the internet. If your network uses a VPN, DNS filter or ad blocker, allow ghcr.io and github.com.' },
  { problem: 'Not enough room in Docker’s storage', pattern: /(?:\/var\/lib\/docker|docker\.img|register layer|extract)[^\n]*no space left on device/i, hint: 'Docker filled the drive that holds its images. Free some space on that drive, or remove images no container uses, then try again.' },
  { problem: 'Out of memory', pattern: /out of memory|heap out of memory|OOMKilled|Killed process|cannot allocate memory|ENOMEM/i, hint: 'The host ran short of RAM. Close other apps or containers, or turn off machine learning on small machines.' },
  { problem: 'Disk full', pattern: /no space left on device|ENOSPC|disk quota exceeded/i, hint: 'A drive is full. Free space on the library, database or Docker drive.' },
  { problem: 'Permission denied', pattern: /permission denied|EACCES|EPERM|operation not permitted/i, hint: 'A container cannot read or write a folder. Check the folder owner and share permissions on the host.' },
  { problem: 'Read-only drive', pattern: /read-only file system|EROFS/i, hint: 'A drive was mounted read-only, often after a disk error. Check the drive on the host.' },
  { problem: 'Connection refused', pattern: /ECONNREFUSED|connection refused/i, hint: 'A service was not listening when another tried to reach it. Usually it was still starting or had crashed.' },
  { problem: 'Name lookup failed', pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo|could not resolve|Temporary failure in name resolution/i, hint: 'DNS is not answering inside Docker. Check the host DNS settings and internet connection.' },
  { problem: 'Network timeout', pattern: /ETIMEDOUT|ECONNRESET|socket hang up|timed out/i, hint: 'A connection dropped or took too long. Check the network, firewall or VPN.' },
  { problem: 'Certificate or clock error', pattern: /CERT_|self[- ]signed certificate|UNABLE_TO_VERIFY|certificate (has expired|is not yet valid|verify failed)|clock skew/i, hint: 'A secure connection was rejected. Check the host clock and any proxy that inspects HTTPS.' },
  { problem: 'Database not shut down cleanly', pattern: /was not properly shut down|database system was interrupted|automatic recovery in progress|invalid record length|checksum mismatch/i, hint: 'PostgreSQL recovered from a crash or power loss. If this repeats, check the drive and power.' },
  { problem: 'Database refused connection', pattern: /too many connections|password authentication failed|role .* does not exist|database .* does not exist|the database system is (starting up|shutting down)/i, hint: 'The server could not sign in to its database. Restart the library from Manager.' },
  { problem: 'Graphics acceleration failed', pattern: /^(?=.*(?:CUDA|cuDNN|ROCm|OpenVINO|nvidia|\/dev\/dri|VAAPI|onnxruntime|ExecutionProvider))(?=.*(?:error|fail|not found|unavailable|unable|cannot)).*/i, hint: 'The GPU could not be used. Update the host GPU driver, or choose CPU in container settings.' },
  { problem: 'Model download failed', pattern: /(download|fetch).*(model|weights).*(fail|error)|failed to (load|download) model/i, hint: 'Machine learning could not get its models. Check the internet connection and free space.' },
  { problem: 'Crash', pattern: /segmentation fault|SIGSEGV|SIGABRT|core dumped|uncaught exception|unhandled rejection|panic:/i, hint: 'A process crashed. Include this report when you ask for help.' },
];

/** Known problems seen in one service's log, with a count and one (already redacted) example line. */
export function findProblems(service: string, log: string): Problem[] {
  const found = new Map<string, Problem>();
  for (const line of log.split('\n'))
    for (const known of KNOWN)
      if (known.pattern.test(line)) {
        const seen = found.get(known.problem);
        if (seen) seen.count++;
        else found.set(known.problem, { service, problem: known.problem, hint: known.hint, count: 1, example: line.trim().slice(0, 300) });
        break;
      }
  return [...found.values()];
}

/**
 * What a failed Docker command ran into, and what to do, from its redacted stderr tail; undefined when no known
 * problem matches. Only fixed wording leaves here (and a port number), never stderr itself: it can hold folder
 * paths and secrets. A crash points at a report the operation screen does not show, so it keeps today's message.
 */
export function explainFailure(stderr: string): string | undefined {
  const lines = stderr.split('\n');
  for (const known of KNOWN) {
    if (known.problem === 'Crash') continue;
    const line = lines.find((l) => known.pattern.test(l));
    if (!line) continue;
    const port = known.problem === 'Port in use' && /(?:\d{1,3}(?:\.\d{1,3}){3}|\]|::):(\d{1,5})\b/.exec(line)?.[1];
    return `${port ? `Port ${port} is in use` : known.problem}. ${known.hint}`;
  }
  return undefined;
}

/** Error and warning lines, by the level words Node, Python, PostgreSQL and Nest print. */
export function levelCounts(log: string) {
  const lines = log.split('\n');
  return {
    errors: lines.filter((l) => /\b(ERROR|FATAL|PANIC|CRITICAL|Traceback)\b|\bError:/.test(l)).length,
    warnings: lines.filter((l) => /\b(WARN|WARNING)\b/.test(l)).length,
  };
}

const serviceName = (c: Container) => c.Config.Labels?.['com.docker.compose.service'] ?? c.Name.replace(/^\//, '');
const ms = (start: number) => `${Date.now() - start} ms`;

// Runs inside the server container (Node is there); it sees the stack network exactly as the server does.
const SERVER_PROBE = `const net=require('node:net'),dns=require('node:dns').promises,t=5000,ml=process.argv[1],cloud=process.env.FRAMELEAF_CLOUD_URL||'https://api.frameleaf.cloud';
const tcp=(h,p)=>new Promise(r=>{const s=net.connect(p,h),d=()=>{s.destroy()};s.setTimeout(t);s.on('connect',()=>{d();r('ok')});s.on('timeout',()=>{d();r('timed out')});s.on('error',e=>r(e.code||'error'))});
const get=u=>{const t0=Date.now();return fetch(u,{signal:AbortSignal.timeout(t)}).then(r=>({status:r.status,date:r.headers.get('date'),sent:t0,received:Date.now()}),e=>({error:(e.cause&&e.cause.code)||e.name}))};
const host=new URL(cloud).hostname;
Promise.all([tcp('database',5432),get('http://127.0.0.1:2283/api/server/ping'),ml?get('http://'+ml+':3003/ping'):null,dns.lookup(host).then(()=>'ok',e=>e.code||'error'),get(cloud)]).then(([database,api,ml,dns,cloud])=>process.stdout.write(JSON.stringify({database,api,ml,dns,cloud,host})));`;
// Runs in the LAN discovery companion, which uses host networking: the same address phones on the network use.
const LAN_PROBE = `fetch((process.env.FRAMELEAF_DISCOVERY_URL||'http://127.0.0.1:2283')+'/api/server/ping',{signal:AbortSignal.timeout(5000)}).then(r=>process.stdout.write(String(r.status)),e=>process.stdout.write((e.cause&&e.cause.code)||e.name));`;

type Http = { status?: number; date?: string | null; sent?: number; received?: number; error?: string };
const http = (r: Http | null | undefined) => (r?.status ? `answered (HTTP ${r.status})` : `no answer (${r?.error ?? 'error'})`);

export async function connectionChecks(docker: Docker, installation: Installation | null, containers: Container[], drives: { name: string; path: string }[]): Promise<Check[]> {
  const checks: Check[] = [];
  let start = Date.now();
  const host = await docker.compatibility().then(
    (h) => ({ ok: true, detail: `Docker ${h.version}, Compose ${h.compose}, ${h.platform} (${ms(start)})` }),
    (error: Error) => ({ ok: false, detail: `Manager cannot use Docker (${error.message}). Check the Docker socket is mounted into Manager.` }),
  );
  checks.push({ name: 'Docker', ...host });
  if (!installation) return checks;

  for (const c of containers) {
    const state = c.State as Container['State'] & { Status?: string; OOMKilled?: boolean; ExitCode?: number; Error?: string; Restarting?: boolean };
    const restarts = (c as Container & { RestartCount?: number }).RestartCount ?? 0;
    const health = state.Health?.Status;
    const problems = [
      !state.Running && `stopped${state.ExitCode ? ` (exit ${state.ExitCode})` : ''}`,
      state.OOMKilled && 'killed for using too much memory',
      health === 'unhealthy' && 'health check failing',
      restarts > 0 && `restarted ${restarts} time${restarts === 1 ? '' : 's'}`,
      state.Error && redact(state.Error),
    ].filter(Boolean);
    checks.push({
      name: `Service ${serviceName(c)}`,
      ok: problems.length ? false : true,
      detail: problems.length ? problems.join(', ') : `running${health ? `, ${health}` : ''}${state.StartedAt ? ` since ${state.StartedAt.slice(0, 19)}Z` : ''}`,
    });
  }

  const server = containers.find((c) => serviceName(c) === 'frameleaf-server');
  const published = server && Object.values(server.HostConfig.PortBindings ?? {}).flat().some((b) => Number(b?.HostPort) === installation.port);
  checks.push({
    name: `Port ${installation.port} published`,
    ok: server ? !!published : null,
    detail: !server
      ? 'Unknown: Manager cannot see the Frameleaf server container.'
      : published
        ? 'Docker forwards this port to the Frameleaf server.'
        : 'Docker does not forward the library port. Restart the library from Manager.',
  });

  const ml = containers.find((c) => serviceName(c).includes('machine-learning'));
  if (server?.State.Running) {
    start = Date.now();
    const probe = await docker
      .node(server.Id, SERVER_PROBE, [ml ? serviceName(ml) : ''])
      .then((text) => JSON.parse(text) as { database: string; api: Http; ml: Http | null; dns: string; cloud: Http; host: string })
      .catch(() => null);
    if (!probe) checks.push({ name: 'Checks from the server', ok: false, detail: 'Manager could not run checks inside the server container.' });
    else {
      checks.push(
        { name: 'Server answers', ok: !!probe.api.status && probe.api.status < 500, detail: `Frameleaf server API ${http(probe.api)}` },
        { name: 'Server → database', ok: probe.database === 'ok', detail: probe.database === 'ok' ? 'PostgreSQL accepts connections.' : `Cannot reach PostgreSQL (${probe.database}).` },
      );
      if (ml) checks.push({ name: 'Server → machine learning', ok: probe.ml?.status === 200, detail: `Machine learning ${http(probe.ml)}` });
      checks.push(
        { name: 'Internet name lookup', ok: probe.dns === 'ok', detail: probe.dns === 'ok' ? `${probe.host} resolves.` : `${probe.host} does not resolve (${probe.dns}). Check the host DNS.` },
        { name: 'Frameleaf Cloud reachable', ok: !!probe.cloud.status, detail: `${probe.host} ${http(probe.cloud)} (${ms(start)} for all server checks)` },
      );
      // The server stamped its Date somewhere between send and receive, to the second: allow for both.
      const { date, sent = 0, received = 0 } = probe.cloud;
      const skew = date ? ((sent + received) / 2 - Date.parse(date)) / 1000 : NaN;
      const slack = (received - sent) / 2000 + 1;
      if (Number.isFinite(skew))
        checks.push({
          name: 'Host clock',
          ok: Math.abs(skew) - slack < 60,
          detail: Math.abs(skew) - slack < 60 ? 'Within a minute of Frameleaf Cloud.' : `About ${Math.round(Math.abs(skew))} s ${skew > 0 ? 'ahead' : 'behind'}. Sign-in and secure connections fail when the clock is wrong; turn on network time.`,
        });
    }
  }

  const lan = containers.find((c) => serviceName(c) === 'frameleaf-lan-discovery');
  if (lan?.State.Running) {
    const answer = await docker.node(lan.Id, LAN_PROBE).catch(() => 'error');
    checks.push({
      name: 'Server reachable on the network',
      ok: /^\d+$/.test(answer) && Number(answer) < 500,
      detail: /^\d+$/.test(answer) ? `The host address phones use answered (HTTP ${answer}).` : `The host address phones use did not answer (${answer}). Check the host firewall.`,
    });
  } else checks.push({ name: 'Network discovery', ok: null, detail: lan ? 'Stopped: phones on the network will not find this library automatically.' : 'Not installed: Manager only listens on this computer, or the release predates it.' });

  for (const { name, path } of drives) {
    const fs = await statfs(path).catch(() => null);
    if (!fs) {
      checks.push({ name, ok: false, detail: 'Manager cannot read this mounted drive.' });
      continue;
    }
    const free = fs.bavail * fs.bsize,
      percent = Math.round((100 * fs.bavail) / Math.max(fs.blocks, 1));
    checks.push({ name, ok: percent >= 5 && free > 2e9, detail: `${(free / 1e9).toFixed(1)} GB free (${percent}%)` });
  }
  return checks;
}

export type Report = {
  generated: string;
  manager: string;
  runtime: string;
  installation: Installation | null;
  host: Awaited<ReturnType<Docker['compatibility']>> | null;
  checks: Check[];
  operations: { kind: string; state: string; step?: string; error?: string; created?: string }[];
  logs: { service: string; text: string }[];
};

const mark = (ok: boolean | null) => (ok === true ? '[ok]  ' : ok === false ? '[FAIL]' : '[info]');

/** A plain-text report safe to paste in a community post: secrets, paths, file names and e-mail addresses removed. */
export function renderReport(report: Report): string {
  const problems = report.logs.flatMap((l) => findProblems(l.service, l.text));
  const failed = report.checks.filter((c) => c.ok === false);
  const i = report.installation;
  return [
    'Frameleaf troubleshooting report',
    `Generated ${report.generated}. Manager tried to remove passwords, keys, folder paths, file names and e-mail addresses.`,
    'Removal is best effort: read the whole report before you post it, and delete anything private that is left (names, addresses, folders).',
    '',
    `Manager ${report.manager} (${report.runtime})`,
    report.host ? `Docker ${report.host.version} · Compose ${report.host.compose} · ${report.host.platform} · ${report.host.processors ?? '?'} CPUs · ${report.host.memory ? `${(report.host.memory / 1e9).toFixed(1)} GB RAM` : '? RAM'}` : 'Docker: unavailable',
    i ? `Library: release ${i.release} · port ${i.port} · machine learning ${i.ml ? 'on' : 'off'} · ${i.origin.replaceAll('_', ' ')} · ${i.mounts.length} media folder(s)` : 'Library: not installed',
    '',
    '== Summary ==',
    ...(failed.length || problems.length
      ? [...failed.map((c) => `- ${c.name}: ${c.detail}`), ...problems.map((p) => `- ${p.service}: ${p.problem} (${p.count}×). ${p.hint}`)]
      : ['No problems found.']),
    '',
    '== Connection checks ==',
    ...report.checks.map((c) => `${mark(c.ok)} ${c.name}: ${c.detail}`),
    '',
    '== Problems found in logs ==',
    ...(problems.length ? problems.map((p) => `${p.service} · ${p.problem} · ${p.count}×\n    e.g. ${p.example}`) : ['None of the known problem patterns appear.']),
    '',
    '== Recent Manager activity ==',
    ...(report.operations.length
      ? report.operations.map((o) => `${o.created ?? ''} ${o.kind} ${o.state}${o.step ? ` at ${o.step}` : ''}${o.error ? `: ${o.error}` : ''}`.trim())
      : ['None.']),
    ...report.logs.flatMap((l) => {
      const { errors, warnings } = levelCounts(l.text);
      return ['', `== Logs: ${l.service} (last 24 hours, ${errors} error and ${warnings} warning lines) ==`, l.text || '(empty)'];
    }),
    '',
  ].join('\n');
}
