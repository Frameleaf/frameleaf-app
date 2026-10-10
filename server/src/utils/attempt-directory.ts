import { Dir } from 'node:fs';
import { opendir } from 'node:fs/promises';

/** A bounded lexical window, even for a directory with millions of entries. */
export class AttemptDirectoryWindows {
  private pages = new Map<string, string[]>();
  private scan?: { path: string; after: string; directory: Dir; names: string[] };

  async read(path: string, after: string, budget: { reads: number; maximum: number; deadline: number }) {
    const page = this.pages.get(path);
    if (page?.some((name) => name > after)) return page;
    this.pages.delete(path);
    if (this.scan && (this.scan.path !== path || this.scan.after !== after)) await this.closeScan();
    this.scan ??= { path, after, directory: await opendir(path), names: [] };
    while (budget.reads < budget.maximum && Date.now() < budget.deadline) {
      const entry = await this.scan.directory.read();
      budget.reads++;
      if (!entry) {
        const names = this.scan.names;
        await this.closeScan();
        this.pages.set(path, names);
        return names;
      }
      if (entry.name > after && (this.scan.names.length < 256 || entry.name < this.scan.names.at(-1)!)) {
        this.scan.names.push(entry.name);
        this.scan.names.sort();
        if (this.scan.names.length > 256) this.scan.names.pop();
      }
    }
    // Continue this stream in the next slice. After process restart, rescan from the
    // persisted lexical `after` (never a mutable directory-entry offset).
  }

  release(path: string) {
    this.pages.delete(path);
  }

  private async closeScan() {
    const scan = this.scan;
    this.scan = undefined;
    await scan?.directory.close();
  }

  async close() {
    this.pages.clear();
    await this.closeScan();
  }
}
