import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HardwareCheck } from 'src/dtos/hardware-check.dto.js';
import { serverVersion } from 'src/constants.js';
import {
  HelpArticleResponseDto,
  HelpAskDto,
  HelpAskResponseDto,
  HelpAskResultSchema,
  HelpIndex,
  HelpIndexResponseDto,
  HelpIndexSchema,
} from 'src/dtos/help.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { handlePromiseError } from 'src/utils/misc.js';

/** `resources` sits beside `src` in a checkout and beside `dist` in a deployment. */
const SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/help/help-index.json');
const HELP_ORIGIN = 'https://frameleaf.app';
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, wait this long before trying the website again. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const ASK_TIMEOUT_MS = 45_000;
const MAX_ARTICLE_BYTES = 512 * 1024;
/** An article id is a guide path such as `using/sharing`, the same shape `HelpArticleSchema` accepts. */
const ARTICLE_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const RUNTIMES: Partial<Record<HardwareCheck['ml']['backend'], string>> = {
  CUDA: 'cuda',
  ROCm: 'rocm',
  OpenVINO: 'openvino',
  CPU: 'cpu',
};

type StoredIndex = { index: HelpIndex; etag: string | null; fetchedAt: string | null };

/** What the Ask service is told about this server: the GPU machine learning runs on, and the version. */
export const askHardware = (check: HardwareCheck | null | undefined) => {
  const container = check && (check.ml.model ? check.ml : check.server.model ? check.server : null);
  const gpu = container ? [container.vendor, container.model].filter(Boolean).join(' ') : undefined;
  const vramGiB = container?.vramGb && container.vramGb > 0 ? Math.min(container.vramGb, 512) : undefined;
  const runtime = check ? RUNTIMES[check.ml.backend] : undefined;
  const hardware = {
    ...(gpu && { gpu: gpu.slice(0, 160) }),
    ...(vramGiB && { vramGiB }),
    ...(runtime && { runtime }),
    version: serverVersion.toString(),
  };
  const label = [
    hardware.gpu,
    vramGiB && `${Math.round(vramGiB)} GB`,
    check?.ml.backend,
    `Frameleaf ${hardware.version}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return { hardware, label };
};

// A stable, per-person session id for the Ask service's per-session limit: not the user id itself.
const askSession = (hash: Buffer) => {
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/**
 * In-app help (FL-488): the frameleaf.app help articles and Ask Frameleaf, through this server so
 * the browser only ever talks to its own server and help still opens offline.
 *
 * - The article index is the website's `/help-index.json`. The last good copy is kept in system
 *   metadata; before the first successful fetch the copy shipped in the image is used. A read
 *   refreshes it in the background once it is a day old (15 minutes after a failure), so a server
 *   nobody opens help on never calls out.
 * - Articles are fetched as Markdown (`/content/docs/<id>.md`) for ids in the index only, and kept
 *   in memory until the index changes.
 * - Ask questions go to `/api/ask/app` with this server's hardware for every question (owner
 *   decision 2026-10-21: it is local and needs no consent). Conversations are never stored.
 */
@Injectable()
export class HelpService extends BaseService {
  private stored: StoredIndex | null = null;
  private refreshing: Promise<void> | null = null;
  private lastAttempt = 0;
  private lastFailed = false;
  private articles = new Map<string, { builtAt: string; markdown: string }>();

  // ponytail: one help website; an environment variable can point it elsewhere when a staging site needs testing
  private readonly origin = HELP_ORIGIN;

  async getIndex(): Promise<HelpIndexResponseDto> {
    const stored = await this.loadIndex();
    const due = stored.fetchedAt ? Date.parse(stored.fetchedAt) + REFRESH_AFTER_MS : 0;
    const now = Date.now();
    if (now >= due && now >= this.lastAttempt + (this.lastFailed ? RETRY_AFTER_MS : 0) && !this.refreshing) {
      this.refreshing = this.refreshIndex().finally(() => (this.refreshing = null));
      handlePromiseError(this.refreshing, this.logger);
    }
    const [config, check] = await Promise.all([
      this.getConfig({ withCache: true }),
      this.systemMetadataRepository.get(SystemMetadataKey.HardwareCheck),
    ]);
    const { index, fetchedAt } = stored;
    return {
      origin: this.origin,
      builtAt: index.builtAt,
      updatedAt: fetchedAt,
      offline: this.lastFailed,
      screens: index.screens,
      screenGuides: index.screenGuides,
      articles: index.articles,
      ask: { enabled: config.help.askEnabled, hardware: askHardware(check).label },
    };
  }

  async getArticle(id: string): Promise<HelpArticleResponseDto> {
    const { index } = await this.loadIndex();
    const article = index.articles.find((item) => item.id === id);
    if (!article || !ARTICLE_ID.test(article.id)) {
      throw new NotFoundException('There is no help article with this id');
    }
    const cached = this.articles.get(id);
    if (cached?.builtAt === index.builtAt) {
      return { id, url: article.url, markdown: cached.markdown };
    }
    try {
      // the id only ever names a path on the help website, never another host
      const url = new URL(`/content/docs/${article.id}.md`, this.origin);
      if (url.origin !== new URL(this.origin).origin) {
        throw new Error('Article address leaves the help website');
      }
      const response = await fetch(url.href, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const markdown = await response.text();
      if (Buffer.byteLength(markdown) > MAX_ARTICLE_BYTES) {
        throw new Error('Article is too large');
      }
      this.articles.set(id, { builtAt: index.builtAt, markdown });
      return { id, url: article.url, markdown };
    } catch (error) {
      this.logger.warn(`Could not load help article ${id}: ${error}`);
      throw new ServiceUnavailableException('This article cannot be loaded right now. Open it on frameleaf.app.');
    }
  }

  async ask(auth: AuthDto, dto: HelpAskDto, signal: AbortSignal): Promise<HelpAskResponseDto> {
    const config = await this.getConfig({ withCache: true });
    if (!config.help.askEnabled) {
      throw new ForbiddenException('Ask Frameleaf is turned off on this server');
    }
    const check = await this.systemMetadataRepository.get(SystemMetadataKey.HardwareCheck);
    const body = {
      question: dto.question,
      turns: dto.turns,
      hardware: askHardware(check).hardware,
      ...(dto.screen && { context: { screen: dto.screen } }),
    };
    let response: Response;
    try {
      response = await fetch(`${this.origin}/api/ask/app`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `Frameleaf-Server/${serverVersion}`,
          'x-ask-session': askSession(this.cryptoRepository.hashSha256(`frameleaf-help:${auth.user.id}`)),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(ASK_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) {
        throw new HttpException('The question was cancelled', 499);
      }
      this.logger.warn(`Ask Frameleaf is unreachable: ${error}`);
      throw new ServiceUnavailableException(
        'Ask Frameleaf cannot be reached right now. Search the help articles instead.',
      );
    }
    if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
      throw new HttpException('Ask Frameleaf is busy. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (response.status === HttpStatus.BAD_REQUEST) {
      throw new BadRequestException('Ask Frameleaf could not read this question');
    }
    const result = HelpAskResultSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !result.success) {
      this.logger.warn(`Ask Frameleaf answered ${response.status}${result.success ? '' : ' with an unexpected body'}`);
      throw new ServiceUnavailableException('Ask Frameleaf cannot answer right now. Search the help articles instead.');
    }
    return result.data;
  }

  private async loadIndex(): Promise<StoredIndex> {
    if (!this.stored) {
      const saved = await this.systemMetadataRepository.get(SystemMetadataKey.HelpIndex);
      const parsed = saved && HelpIndexSchema.safeParse(saved.index);
      this.stored = parsed?.success
        ? { ...saved!, index: parsed.data }
        : { index: HelpIndexSchema.parse(JSON.parse(await readFile(SNAPSHOT, 'utf8'))), etag: null, fetchedAt: null };
    }
    return this.stored;
  }

  private async refreshIndex(): Promise<void> {
    this.lastAttempt = Date.now();
    const current = await this.loadIndex();
    try {
      const response = await fetch(`${this.origin}/help-index.json`, {
        headers: current.etag ? { 'if-none-match': current.etag } : {},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const fetchedAt = new Date().toISOString();
      if (response.status === HttpStatus.NOT_MODIFIED) {
        this.stored = { ...current, fetchedAt };
      } else if (response.ok) {
        this.stored = {
          index: HelpIndexSchema.parse(await response.json()),
          etag: response.headers.get('etag'),
          fetchedAt,
        };
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
      await this.systemMetadataRepository.set(SystemMetadataKey.HelpIndex, {
        index: this.stored.index,
        etag: this.stored.etag,
        fetchedAt,
      });
      this.lastFailed = false;
    } catch (error) {
      // keep serving the copy we have; the panel says help is offline until a fetch works again
      this.lastFailed = true;
      this.logger.warn(`Could not refresh the help index from ${this.origin}: ${error}`);
    }
  }
}
