import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Refusal, releaseTag, sha256, type NasManifest } from './contracts.js';

const require = createRequire(import.meta.url);
const { INSTALL_FILES } = require('../../.github/frameleaf-release.cjs') as { INSTALL_FILES: string[] };
const REPOSITORY = 'https://api.github.com/repos/Frameleaf/frameleaf-app';
export type VerifiedRelease = {
  directory: string;
  nas: NasManifest;
  release: Record<string, unknown>;
};
export function offered(body: string, seed: string, tag: string): boolean {
  if (/^[ \t]*withdrawn:[ \t]*\S/im.test(body)) return false;
  const line = /^[ \t]*rollout:[ \t]*(.*?)[ \t]*$/im.exec(body)?.[1];
  if (line === undefined) return true;
  const raw = /^(\d{1,3})\s*%?$/.exec(line)?.[1];
  const percent = raw === undefined ? 0 : Number(raw);
  const version = tag.replace(/^frameleaf-v/, '').replace(/-\d+$/, '');
  return percent <= 100 && parseInt(sha256(`${seed}:${version}`).slice(0, 8), 16) % 100 < percent;
}
async function github(path: string): Promise<any> {
  const response = await fetch(`${REPOSITORY}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Frameleaf-Manager' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Refusal('release_service_unavailable', 503);
  const text = await response.text();
  if (text.length > 4_000_000) throw new Refusal('invalid_release_response');
  return JSON.parse(text);
}
export class Releases {
  constructor(
    private root: string,
    private seed: string,
  ) {}
  async available(): Promise<{ tag: string; publishedAt: string; notes: string }[]> {
    const releases = await github('releases?per_page=30');
    return releases
      .filter(
        (r: any) =>
          !r.draft &&
          !r.prerelease &&
          releaseTag.safeParse(r.tag_name).success &&
          offered(r.body ?? '', this.seed, r.tag_name),
      )
      .map((r: any) => ({ tag: r.tag_name, publishedAt: r.published_at, notes: String(r.body ?? '').slice(0, 32000) }));
  }
  async eligible(tag: string): Promise<any> {
    releaseTag.parse(tag);
    const release = await github(`releases/tags/${tag}`);
    if (release.draft || release.prerelease || !offered(release.body ?? '', this.seed, tag))
      throw new Refusal('release_not_eligible');
    return release;
  }
  async acquire(tag: string): Promise<VerifiedRelease> {
    const metadata = await this.eligible(tag);
    const directory = join(this.root, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      for (const name of [...INSTALL_FILES, 'nas-manifest.json', 'release-manifest.json', 'SHA256SUMS']) {
        const asset = metadata.assets?.find((a: any) => a.name === name);
        if (
          !asset ||
          asset.size > 4_000_000 ||
          !String(asset.browser_download_url).startsWith(
            `https://github.com/Frameleaf/frameleaf-app/releases/download/${tag}/`,
          )
        )
          throw new Refusal('release_bundle_missing');
        const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Refusal('release_download_failed', 503);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== asset.size || bytes.length > 4_000_000) throw new Refusal('release_asset_size_mismatch');
        await writeFile(join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
      }
      return await this.verify(directory, tag);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async verify(directory: string, tag: string): Promise<VerifiedRelease> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../release-worker.cjs', import.meta.url), {
        workerData: { directory, tag },
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Refusal('release_verification_timeout', 503));
      }, 600_000);
      worker.once('message', (data) => {
        clearTimeout(timeout);
        if (data.error) reject(new Refusal(data.error));
        else resolve({ directory, ...data });
      });
      worker.once('error', () => {
        clearTimeout(timeout);
        reject(new Refusal('release_verification_failed'));
      });
      worker.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Refusal('release_verification_failed'));
        }
      });
    });
  }
}
