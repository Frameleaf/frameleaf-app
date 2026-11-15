import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** An unfinished upload is forgotten this long after its last bytes; the server lets it go too. */
const IDLE_MS = 24 * 60 * 60 * 1000;

type Entry = { url: string; updatedAt: number };

/** Where unfinished uploads are remembered between runs (FL-849). */
export const uploadStatePath = () =>
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Frameleaf', 'uploads.json')
    : path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'frameleaf', 'uploads.json');

/** One file on one server, as it is now: a changed file is a different upload. */
export const uploadStateKey = (baseUrl: string, filepath: string, size: number, mtimeMs: number, sha256: string) =>
  [baseUrl, path.resolve(filepath), size, Math.trunc(mtimeMs), sha256].join('|');

/**
 * Resource URLs of unfinished uploads, keyed by `uploadStateKey`. Written after every change (small
 * file, renamed into place) so a killed process loses nothing it had started.
 *
 * ponytail: one process at a time; two CLIs uploading at once may overwrite each other's entries,
 * which only costs a fresh start for the lost ones.
 */
export class UploadState {
  private entries: Record<string, Entry> = {};

  constructor(
    private file = uploadStatePath(),
    now = Date.now(),
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
      for (const [key, entry] of Object.entries(saved)) {
        if (typeof entry?.url === 'string' && now - entry.updatedAt < IDLE_MS) {
          this.entries[key] = entry;
        }
      }
    } catch {
      // nothing saved yet, or unreadable: start empty
    }
  }

  get(key: string) {
    return this.entries[key]?.url;
  }

  set(key: string, url: string) {
    this.entries[key] = { url, updatedAt: Date.now() };
    this.save();
  }

  /** Keeps an entry alive while its bytes are still arriving. */
  touch(key: string) {
    const entry = this.entries[key];
    if (entry && Date.now() - entry.updatedAt > 60_000) {
      entry.updatedAt = Date.now();
      this.save();
    }
  }

  delete(key: string) {
    if (Object.hasOwn(this.entries, key)) {
      delete this.entries[key];
      this.save();
    }
  }

  private save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      // Not being able to remember only costs a fresh start next time.
      console.warn(`Could not save upload progress to ${this.file}: ${error}`);
    }
  }
}
