import { mkdir, readFile, writeFile, readdir, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Docker, command } from './docker.js';
import { Refusal, type Source, type Backup } from './contracts.js';

// Read only the selected source's backup directory. Native backup names carry creation time in
// the source container's timezone; mtime is corroboration, never the backup's asserted age.
// A matching original administrator UUID and creation timestamp binds the SQL to this library.
export const BACKUP_INDEX = String.raw`
const fs=require('node:fs'),p=require('node:path'),z=require('node:zlib'),c=require('node:crypto');
const {pipeline}=require('node:stream/promises'),{Writable}=require('node:stream');
(async()=>{const root=process.argv[1],identity=JSON.parse(process.argv[2]),out=[];if(!fs.existsSync(root)||!identity){process.stdout.write('[]');return;}
if(fs.lstatSync(root).isSymbolicLink()||fs.realpathSync(root)!==p.resolve(root))throw Error();
for(const name of fs.readdirSync(root)){const match=/^immich-db-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-v[\w.-]+-pg[\w.-]+\.sql\.gz$/.exec(name);if(!match)continue;
const takenAt=new Date(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]),Number(match[5]),Number(match[6])).getTime();
const path=p.join(root,name),s=fs.lstatSync(path),age=Date.now()-takenAt;
if(!s.isFile()||!Number.isFinite(takenAt)||age<0||age>86400000||s.mtimeMs<takenAt-1000||s.mtimeMs>Date.now())continue;
try{let tail=Buffer.alloc(0),pending='',columns=null,matched=false;const tables=new Set(),hash=c.createHash('sha256');
function line(value){const copy=/^COPY public\.("?\w+"?) \((.+)\) FROM stdin;$/.exec(value);
if(copy){const table=copy[1].replaceAll('"','');tables.add(table);columns=table==='user'?copy[2].split(', ').map(v=>v.replaceAll('"','')):null;return;}
if(value==='\\.'){columns=null;return;}
if(columns){const row=value.split('\t'),id=row[columns.indexOf('id')],created=row[columns.indexOf('createdAt')];
if(id===identity.id&&Number.isFinite(Date.parse(created))&&Math.abs(Date.parse(created)-Number(identity.createdAt))<1)matched=true;}}
const input=fs.createReadStream(path,{flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW});input.on('data',v=>hash.update(v));
await pipeline(input,z.createGunzip(),new Writable({write(v,e,next){try{tail=Buffer.concat([tail,v]).subarray(-4096);pending+=v.toString('utf8');
let at;while((at=pending.indexOf('\n'))>=0){line(pending.slice(0,at));pending=pending.slice(at+1);}if(pending.length>64*1024*1024)throw Error();next();}catch(error){next(error);}}}));
const after=fs.lstatSync(path);if(s.ino!==after.ino||s.size!==after.size||s.mtimeMs!==after.mtimeMs)continue;
if(matched&&['user','asset','album'].every(t=>tables.has(t))&&/-- PostgreSQL database (?:cluster )?dump complete/.test(tail.toString()))out.push({name,takenAt,sha256:hash.digest('hex'),verified:true});
}catch{}}
process.stdout.write(JSON.stringify(out));})().catch(()=>process.exit(1));`;
export async function sourceBackups(docker: Docker, source: Source): Promise<Backup[]> {
  const media =
    source.environment.IMMICH_MEDIA_LOCATION ??
    (source.mounts.some((m) => m.target === '/data') ? '/data' : '/usr/src/app/upload');
  const identity = await docker.sql(
    source.database,
    `SELECT row_to_json(identity) FROM (SELECT id, floor(extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAt"
    FROM public.user WHERE "isAdmin"=true ORDER BY "createdAt", id LIMIT 1) identity;`,
  );
  if (!identity.trim()) return [];
  const backups = JSON.parse(await docker.node(source.app, BACKUP_INDEX, [join(media, 'backups'), identity.trim()]));
  return backups.map((b: Omit<Backup, 'source' | 'database'>) => ({
    ...b,
    source: source.id,
    database: source.postgres.identity,
  }));
}
export class Backups {
  constructor(
    private repository: string,
    private keyFile: string,
    private execute: typeof command = command,
  ) {}
  private args(args: string[]): string[] {
    return ['--repo', this.repository, '--password-file', this.keyFile, '--json', ...args];
  }
  async unlock(key: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Refusal('invalid_recovery_key');
    const temporary = `${this.keyFile}.${randomUUID()}`;
    await writeFile(temporary, key, { mode: 0o600, flag: 'wx' });
    try {
      await this.execute('restic', ['--repo', this.repository, '--password-file', temporary, 'cat', 'config']);
      await rename(temporary, this.keyFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async initialize(): Promise<void> {
    await mkdir(this.repository, { recursive: true, mode: 0o700 });
    const files = await readdir(this.repository);
    if (files.length && !files.includes('config')) throw new Refusal('backup_destination_not_empty');
    try {
      await stat(this.keyFile);
    } catch {
      if (files.length) throw new Refusal('recovery_key_required');
      await writeFile(this.keyFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    }
    if (!files.length) await this.execute('restic', this.args(['init']));
    await this.execute('restic', this.args(['cat', 'config']));
  }
  async snapshot(checkpointDirectory: string, operationId: string): Promise<string> {
    // The caller constructs this database/config-only directory. Never accept a list of user paths.
    const permitted = new Set(['database.dump', 'recovery.json', 'compose.json', 'application-settings.json']);
    for (const file of await readdir(checkpointDirectory))
      if (!permitted.has(file) || !(await stat(join(checkpointDirectory, file))).isFile())
        throw new Refusal('invalid_database_checkpoint');
    const recovery = JSON.parse(await readFile(join(checkpointDirectory, 'recovery.json'), 'utf8'));
    const format = recovery?.databaseFormat;
    if (!['frameleaf-canonical', 'immich-source'].includes(format))
      throw new Refusal('unknown_checkpoint_database_format');
    const existing = JSON.parse(
      await this.execute('restic', this.args(['snapshots', '--tag', `frameleaf-manager-database,${operationId}`])),
    );
    if (existing.length > 1) throw new Refusal('ambiguous_operation_backup');
    if (existing.length === 1) {
      if (
        !/^[a-f0-9]{64}$/.test(existing[0].id) ||
        existing[0].paths?.length !== 1 ||
        existing[0].paths[0] !== checkpointDirectory ||
        !existing[0].tags?.includes(format) ||
        existing[0].tags?.includes(format === 'frameleaf-canonical' ? 'immich-source' : 'frameleaf-canonical')
      )
        throw new Refusal('invalid_operation_backup');
      await this.execute('restic', this.args(['check', '--read-data']), { timeout: 7_200_000 });
      return existing[0].id;
    }
    const output = await this.execute(
      'restic',
      this.args(['backup', '--tag', 'frameleaf-manager-database', '--tag', operationId, '--tag', format, '.']),
      { cwd: checkpointDirectory, timeout: 7_200_000 },
    );
    const summary = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((line) => line.message_type === 'summary');
    if (!summary?.snapshot_id || !/^[a-f0-9]{64}$/.test(summary.snapshot_id)) throw new Refusal('backup_incomplete');
    await this.execute('restic', this.args(['check', '--read-data']), { timeout: 7_200_000 });
    return summary.snapshot_id;
  }
  async list(): Promise<{ id: string; time: string; paths: string[] }[]> {
    const snapshots = JSON.parse(
      await this.execute('restic', this.args(['snapshots', '--tag', 'frameleaf-manager-database,frameleaf-canonical'])),
    );
    return snapshots
      .filter(
        (s: any) =>
          s.tags?.includes('frameleaf-manager-database') &&
          s.tags.includes('frameleaf-canonical') &&
          !s.tags.includes('immich-source'),
      )
      .map((s: any) => ({ id: s.id, time: s.time, paths: s.paths }))
      .sort((a: { time: string }, b: { time: string }) => Date.parse(b.time) - Date.parse(a.time));
  }
  async status() {
    const exists = async (file: string) =>
      stat(file)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
    const configured = await exists(join(this.repository, 'config'));
    const keyAvailable = await exists(this.keyFile),
      unlocked = configured && keyAvailable;
    return {
      configured,
      unlocked,
      keyAvailable,
      snapshots: unlocked ? (await this.list()).map(({ id, time }) => ({ id, time })) : [],
    };
  }
  async restore(snapshot: string, emptyDirectory: string): Promise<void> {
    const entry = (await this.list()).find((s) => s.id === snapshot);
    if (!/^[a-f0-9]{64}$/.test(snapshot) || !entry || entry.paths.length !== 1 || !entry.paths[0].startsWith('/'))
      throw new Refusal('unknown_snapshot');
    await mkdir(emptyDirectory, { mode: 0o700 });
    await this.execute(
      'restic',
      // backup('.') stores checkpoint files at the snapshot root. paths[] is source metadata,
      // not a subtree in that snapshot; selecting it makes otherwise valid recovery fail.
      this.args(['restore', snapshot, '--target', emptyDirectory, '--verify']),
      { timeout: 7_200_000 },
    );
  }
  async recoveryKey(): Promise<string> {
    return readFile(this.keyFile, 'utf8');
  }
}
