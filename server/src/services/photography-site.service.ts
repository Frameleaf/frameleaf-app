import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  PhotographyInquiry,
  PhotographyInquiryCreateDto,
  PhotographySiteSaveDto,
} from 'src/dtos/photography-workflow.dto.js';
import { CacheControl, JobName, NotificationLevel, NotificationType, StorageFolder } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EmailRepository, EmailTemplate } from 'src/repositories/email.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import {
  PhotographyWorkflowRepository,
  StudioRecord,
  StudioSiteMedia,
  WorkflowRow,
} from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { getConfig } from 'src/utils/config.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { OpenGraphTags, getExternalDomain } from 'src/utils/misc.js';
import {
  PhotographySite,
  SITE_PHOTO_WIDTHS,
  SITE_SLUG,
  normalisePhotographySite,
  portfolioItems,
  portfolioKey,
} from 'src/utils/photography-site.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Newest first; older inquiries drop off (they were emailed when they arrived). */
const MAX_INQUIRIES = 500;

/**
 * FL-702: the Clients studio website (FL-701 design, approved 2026-10-30).
 *
 * The site keeps its own sized copies of every portfolio photograph, made from the gallery's published
 * web rendition when the photograph is added. A gallery that expires or is republished no longer takes
 * photos off the website; a photograph that is withheld, rejected, locked or deleted still does, checked
 * on every view.
 */
@Injectable()
export class PhotographySiteService {
  /** Studios whose older websites are having their photo copies made (see `catchUp`). */
  private catchingUp = new Set<string>();
  constructor(
    private repository: PhotographyWorkflowRepository,
    private workspace: PhotographyWorkspaceRepository,
    private workflow: PhotographyWorkflowService,
    private email: EmailRepository,
    private jobs: JobRepository,
    private notifications: NotificationRepository,
    private websocket: WebsocketRepository,
    private configRepository: ConfigRepository,
    private metadata: SystemMetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PhotographySiteService.name);
  }

  async site(auth: AuthDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const { revision, record } = await this.repository.studioRecord(ownerId);
    return this.view(revision, normalisePhotographySite(record.site, auth.user.name), record);
  }

  async saveSite(auth: AuthDto, input: PhotographySiteSaveDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const { expectedRevision, site } = PhotographySiteSaveDto.schema.parse(input);
    const owner = await this.repository.siteOwnerBySlug(site.slug);
    if (owner && owner !== ownerId) throw new ConflictException('That website address is taken; choose another');
    // ponytail: two studios saving the same new address in the same instant can both win; a unique index on
    // value->'site'->>'slug' closes that if it ever matters.
    const { record: current } = await this.repository.studioRecord(ownerId);
    const { media, created } = await this.copyNewPhotos(ownerId, site, current.media ?? {});
    let saved;
    try {
      saved = await this.repository.mutateStudio(ownerId, expectedRevision, (record) => {
        const removed = Object.entries(record.media ?? {}).filter(([key]) => !media[key]);
        record.site = site;
        record.media = media;
        return removed.map(([, item]) => item);
      });
    } catch (error) {
      // Nothing refers to copies from a save that did not happen.
      for (const { copy } of created) await this.removeFiles(copy);
      throw error;
    }
    for (const item of saved.result) await this.removeFiles(item);
    return this.view(saved.revision, site, saved.record);
  }

  private view(revision: string | null, site: PhotographySite, record: StudioRecord) {
    return { revision, site, url: `/studio/${site.slug}`, inquiries: record.inquiries ?? [] };
  }

  /**
   * Copies each newly added photograph at every website width; keeps copies that are still current.
   * `skipFailures` (the background catch-up for older sites) leaves out a photograph it cannot copy;
   * otherwise the first failure removes this call's copies and is thrown.
   */
  private async copyNewPhotos(
    ownerId: string,
    site: PhotographySite,
    existing: Record<string, StudioSiteMedia>,
    skipFailures = false,
  ) {
    const media: Record<string, StudioSiteMedia> = {};
    const created: { key: string; copy: StudioSiteMedia }[] = [];
    const shoots = new Map();
    // ponytail: copies are made inside the save request (about 0.1 s per photograph); move to a job if
    // photographers add hundreds at once and saves feel slow.
    for (const item of portfolioItems(site)) {
      const key = portfolioKey(item);
      if (existing[key]) {
        media[key] = existing[key];
        continue;
      }
      try {
        const copy = await this.copyPhoto(ownerId, item, shoots);
        created.push({ key, copy });
        media[key] = copy;
      } catch (error) {
        if (skipFailures) continue;
        for (const made of created) await this.removeFiles(made.copy);
        throw error;
      }
    }
    return { media, created };
  }

  private async copyPhoto(
    ownerId: string,
    item: { shootId: string; captureId: string },
    shoots: Map<string, Promise<WorkflowRow>>,
  ): Promise<StudioSiteMedia> {
    const source = await this.workflow.portfolioSource(ownerId, item.shootId, item.captureId, shoots);
    const version = randomUUID().slice(0, 8);
    const folder = path.join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'photography', 'site');
    const files: StudioSiteMedia['files'] = [];
    let size = { width: 0, height: 0 };
    try {
      for (const width of SITE_PHOTO_WIDTHS) {
        const { data, info } = await sharp(source.path, { failOn: 'warning' })
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 84, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        const file = path.join(folder, `${item.captureId}-${version}-${width}.jpg`);
        await atomicFile(file, data);
        files.push({ width: info.width, path: file });
        size = { width: info.width, height: info.height };
      }
    } catch (error) {
      for (const file of files) await rm(file.path, { force: true });
      throw error;
    }
    return { revisionId: source.revisionId, version, assetId: source.assetId, ...size, files };
  }

  /**
   * FL-702 review: sites saved before the website kept its own copies have none yet. Make them in the
   * background on the first public view (one studio at a time), so the photographer does not have to
   * save again; until then those photographs are shown the old way, from their gallery.
   */
  private catchUp(ownerId: string) {
    if (this.catchingUp.has(ownerId)) return;
    this.catchingUp.add(ownerId);
    void (async () => {
      try {
        const { record } = await this.repository.studioRecord(ownerId);
        const owner = await this.repository.studioOwner(ownerId);
        const site = normalisePhotographySite(record.site, owner?.name ?? '');
        const { created } = await this.copyNewPhotos(ownerId, site, record.media ?? {}, true);
        if (created.length === 0) return;
        let unused;
        try {
          unused = await this.repository.mutateStudio(ownerId, undefined, (current) => {
            // Keep only copies the site still shows and that no save made meanwhile.
            const wanted = new Set(
              portfolioItems(normalisePhotographySite(current.site, '')).map((item) => portfolioKey(item)),
            );
            current.media ??= {};
            const left: StudioSiteMedia[] = [];
            for (const { key, copy } of created) {
              if (wanted.has(key) && !current.media[key]) current.media[key] = copy;
              else left.push(copy);
            }
            return left;
          });
        } catch (error) {
          // Not recorded, so nothing would ever refer to these copies.
          for (const { copy } of created) await this.removeFiles(copy);
          throw error;
        }
        for (const copy of unused.result) await this.removeFiles(copy);
      } catch (error) {
        this.logger.warn(`Studio website photo catch-up failed: ${error}`);
      } finally {
        this.catchingUp.delete(ownerId);
      }
    })();
  }

  private async removeFiles(item: StudioSiteMedia) {
    for (const file of item.files) await rm(file.path, { force: true });
  }

  /** `/studio/<slug>`; links made before FL-702 used the owner's id. */
  private async resolve(idOrSlug: string) {
    const ownerId = UUID.test(idOrSlug)
      ? idOrSlug
      : SITE_SLUG.test(idOrSlug)
        ? await this.repository.siteOwnerBySlug(idOrSlug)
        : undefined;
    if (!ownerId) throw new NotFoundException();
    await this.repository.studioLive(ownerId);
    const { record } = await this.repository.studioRecord(ownerId);
    const owner = await this.repository.studioOwner(ownerId);
    const site = normalisePhotographySite(record.site, owner?.name ?? '');
    if (!site.enabled) throw new NotFoundException();
    return { ownerId, site, record };
  }

  async publicSite(idOrSlug: string) {
    const { ownerId, site, record } = await this.resolve(idOrSlug);
    const items = portfolioItems(site);
    const media = record.media ?? {};
    const allowed = await this.workflow.portfolioAllowed(
      ownerId,
      items.map((item) => ({ ...item, revisionId: media[portfolioKey(item)]?.revisionId })),
    );
    // Photographs from a site saved before FL-702 have no copies yet: show them from their gallery,
    // the way that site showed them, while the copies are made.
    const fromGallery = new Set<string>();
    const missing = items.filter((item) => !media[portfolioKey(item)]);
    if (missing.length > 0) {
      const shoots = new Map<string, Promise<WorkflowRow>>();
      for (const item of missing) {
        try {
          await this.workflow.portfolioSource(ownerId, item.shootId, item.captureId, shoots);
          fromGallery.add(portfolioKey(item));
        } catch {
          // Not publishable from its gallery any more; left out, as before FL-702.
        }
      }
      this.catchUp(ownerId);
    }
    const descriptions = await this.repository.assetDescriptions(
      ownerId,
      items.map((item) => media[portfolioKey(item)]?.assetId).filter((id): id is string => !!id),
    );
    const photo = (item: { shootId: string; captureId: string }, fallbackAlt: string) => {
      const key = portfolioKey(item);
      const copy = media[key];
      if (!copy && fromGallery.has(key))
        return {
          key,
          alt: fallbackAlt,
          width: 0,
          height: 0,
          url: `/api/photography/studios/${ownerId}/photos/${item.shootId}/${item.captureId}`,
          srcset: '',
        };
      if (!copy || !allowed.has(key)) return null;
      const url = (width: number) =>
        `/api/photography/studios/${ownerId}/photos/${item.shootId}/${item.captureId}/${width}?v=${copy.version}`;
      return {
        key,
        alt: (copy.assetId && descriptions.get(copy.assetId)) || fallbackAlt,
        width: copy.width,
        height: copy.height,
        url: url(SITE_PHOTO_WIDTHS.at(-1)!),
        srcset: SITE_PHOTO_WIDTHS.map((width, index) => `${url(width)} ${copy.files[index]?.width ?? width}w`).join(
          ', ',
        ),
      };
    };
    const brand = (await this.workspace.get(ownerId))?.value.brand;
    const eligibleLogo = brand?.logoAssetId && (await this.repository.logo(ownerId, brand.logoAssetId))[0];
    return {
      ownerId,
      template: site.template,
      colours: site.colours,
      coverFocal: site.coverFocal,
      sections: site.sections,
      title: site.title,
      about: site.about,
      contact: site.contact,
      packages: site.packages,
      testimonials: site.testimonials,
      faq: site.faq,
      trustedBy: site.trustedBy,
      cover: site.cover ? photo(site.cover, site.title) : null,
      collections: site.collections.map((collection) => {
        const photos = collection.items.map((item, index) => photo(item, `${collection.name}, ${index + 1}`));
        return { id: collection.id, name: collection.name, photos: photos.filter((p) => p !== null) };
      }),
      brand: {
        name: brand?.name ?? site.title,
        tagline: brand?.tagline ?? '',
        email: brand?.email ?? '',
        phone: brand?.phone ?? '',
        color: brand?.color ?? '#577059',
        background: brand?.background ?? '#f5f3ed',
        textColor: brand?.textColor ?? '#263329',
        font: brand?.font ?? 'editorial',
        logoUrl: eligibleLogo ? `/api/photography/studios/${ownerId}/logo` : null,
      },
    };
  }

  /** `width` absent: the largest copy, or (before the copies exist) the gallery's web photograph. */
  async publicPhoto(ownerId: string, shootId: string, captureId: string, width?: number) {
    const { site, record } = await this.resolve(ownerId);
    const key = portfolioKey({ shootId, captureId });
    if (portfolioItems(site).every((item) => portfolioKey(item) !== key)) throw new NotFoundException();
    const copy = record.media?.[key];
    if (!copy) {
      if (width !== undefined) throw new NotFoundException();
      const source = await this.workflow.portfolioSource(ownerId, shootId, captureId);
      return new FileDownloadResponse({
        path: source.path,
        contentType: 'image/jpeg',
        cacheControl: CacheControl.None,
      });
    }
    const index =
      width === undefined
        ? SITE_PHOTO_WIDTHS.length - 1
        : SITE_PHOTO_WIDTHS.indexOf(width as (typeof SITE_PHOTO_WIDTHS)[number]);
    if (index === -1) throw new NotFoundException();
    if (
      !(await this.workflow.portfolioAllowed(ownerId, [{ shootId, captureId, revisionId: copy.revisionId }])).has(key)
    )
      throw new NotFoundException();
    return new FileDownloadResponse({
      path: copy.files[index].path,
      contentType: 'image/jpeg',
      cacheControl: CacheControl.None,
    });
  }

  async inquire(idOrSlug: string, input: PhotographyInquiryCreateDto) {
    const dto = PhotographyInquiryCreateDto.schema.parse(input);
    const { ownerId, site } = await this.resolve(idOrSlug);
    // Bots that fill every field are told it worked, and nothing is kept.
    if (dto.website) return;
    const wanted = dto.kind === 'gallery-link' ? 'clients' : 'inquiry';
    if (site.sections.every((section) => !(section.id === wanted && section.on))) throw new NotFoundException();
    if (dto.kind === 'inquiry' && (!dto.name || !dto.message))
      throw new BadRequestException('Add your name and a message');
    const inquiry: PhotographyInquiry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      kind: dto.kind,
      name: dto.kind === 'gallery-link' ? '' : dto.name,
      email: dto.email,
      date: dto.kind === 'gallery-link' ? '' : dto.date,
      type: dto.kind === 'gallery-link' ? '' : dto.type,
      message: dto.kind === 'gallery-link' ? '' : dto.message,
    };
    await this.repository.mutateStudio(ownerId, undefined, (record) => {
      record.inquiries = [inquiry, ...(record.inquiries ?? [])].slice(0, MAX_INQUIRIES);
    });
    await this.tell(ownerId, site, inquiry);
  }

  /** The studio hears about it in Frameleaf and, when email is set up, by email (FL-701 decision B). */
  private async tell(ownerId: string, site: PhotographySite, inquiry: PhotographyInquiry) {
    const title =
      inquiry.kind === 'gallery-link' ? 'Gallery link requested' : `New inquiry from ${inquiry.name || inquiry.email}`;
    // The inquiry is already saved: a notification or mail problem is logged, never sent back to the visitor,
    // who would otherwise think it failed and send it again.
    try {
      const item = await this.notifications.create({
        userId: ownerId,
        type: NotificationType.Custom,
        level: NotificationLevel.Info,
        title,
        description:
          inquiry.kind === 'gallery-link'
            ? `${inquiry.email} asked your website for their gallery link.`
            : inquiry.message.slice(0, 200),
        data: JSON.stringify({ link: '/photography?section=website' }),
      });
      this.websocket.clientSend('on_notification', ownerId, mapNotification(item));
    } catch (error) {
      this.logger.warn(`Studio inquiry notification not created: ${error}`);
    }
    try {
      const owner = await this.repository.studioOwner(ownerId);
      if (!owner?.email) return;
      const { server, templates } = await getConfig(
        { configRepo: this.configRepository, metadataRepo: this.metadata, logger: this.logger },
        { withCache: true },
      );
      const baseUrl = getExternalDomain(server);
      const { html, text } = await this.email.renderEmail({
        template: EmailTemplate.STUDIO_INQUIRY,
        data: {
          baseUrl,
          showBranding: templates.email.showBranding,
          studioName: site.title,
          ...inquiry,
          link: baseUrl ? `${baseUrl}/photography?section=website` : undefined,
        },
      });
      await this.jobs.queue({ name: JobName.SendMail, data: { to: owner.email, subject: title, html, text } });
    } catch (error) {
      this.logger.warn(`Studio inquiry email not queued: ${error}`);
    }
  }

  /** Page title, description and share image for `/studio/<slug>` (FL-701 item 16). */
  async metadataTags(idOrSlug: string, defaultDomain?: string): Promise<OpenGraphTags> {
    const { ownerId, site, record } = await this.resolve(idOrSlug);
    const brand = (await this.workspace.get(ownerId))?.value.brand;
    const cover = site.cover ?? portfolioItems(site)[0];
    const copy = cover && record.media?.[portfolioKey(cover)];
    const allowed =
      cover && copy
        ? await this.workflow.portfolioAllowed(ownerId, [{ ...cover, revisionId: copy.revisionId }])
        : new Set<string>();
    const domain = defaultDomain ?? '';
    return {
      title: site.seoTitle || site.title,
      description: site.seoDescription || brand?.tagline || site.about.slice(0, 160),
      imageUrl:
        cover && copy && allowed.has(portfolioKey(cover))
          ? `${domain}/api/photography/studios/${ownerId}/photos/${cover.shootId}/${cover.captureId}/1280?v=${copy.version}`
          : undefined,
    };
  }
}

async function atomicFile(file: string, bytes: Buffer) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}
