import { Injectable, NotAcceptableException } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { escape } from 'lodash-es';
import { readFileSync } from 'node:fs';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AuthService } from 'src/services/auth.service.js';
import { PhotographySiteService } from 'src/services/photography-site.service.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { OpenGraphTags } from 'src/utils/misc.js';
import { STUDIO_APP_PAGES } from 'src/utils/photography-site.js';

export const render = (index: string, meta: OpenGraphTags) => {
  const [title, description, imageUrl] = [meta.title, meta.description, meta.imageUrl].map((item) =>
    item ? escape(item) : '',
  );

  const tags = `
    <title>${title}</title>
    <meta name="description" content="${description}" />

    <!-- Facebook Meta Tags -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    ${imageUrl ? `<meta property="og:image" content="${imageUrl}" />` : ''}`;

  return index.replace('<!-- metadata:tags -->', () => tags);
};

@Injectable()
export class ApiService {
  constructor(
    private authService: AuthService,
    private sharedLinkService: SharedLinkService,
    private siteService: PhotographySiteService,
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ApiService.name);
  }

  ssr(excludePaths: string[]) {
    const { resourcePaths } = this.configRepository.getEnv();

    let index = '';
    try {
      index = readFileSync(resourcePaths.web.indexHtml).toString();
    } catch {
      this.logger.warn(`Unable to open ${resourcePaths.web.indexHtml}, skipping SSR.`);
    }

    return async (request: Request, res: Response, next: NextFunction) => {
      const method = request.method.toLowerCase();
      if (
        request.url.startsWith('/api') ||
        (method !== 'get' && method !== 'head') ||
        excludePaths.some((item) => request.url.startsWith(item))
      ) {
        return next();
      }

      const responseType = request.accepts('text/html');
      if (!responseType) {
        throw new NotAcceptableException(
          `The route ${request.path} was requested as ${request.header('accept')}, but only returns text/html`,
        );
      }

      let status = 200;
      let html = index;

      const defaultDomain = request.host ? `${request.protocol}://${request.host}` : undefined;

      let meta: OpenGraphTags | null = null;

      const shareKey = request.url.match(/^\/share\/(.+)$/);
      if (shareKey) {
        try {
          const key = shareKey[1];
          const auth = await this.authService.validateSharedLinkKey(key);
          meta = await this.sharedLinkService.getMetadataTags(auth, defaultDomain);
        } catch {
          status = 404;
        }
      }

      const shareSlug = request.url.match(/^\/s\/(.+)$/);
      if (shareSlug) {
        try {
          const slug = shareSlug[1];
          const auth = await this.authService.validateSharedLinkSlug(slug);
          meta = await this.sharedLinkService.getMetadataTags(auth, defaultDomain);
        } catch {
          status = 404;
        }
      }

      // FL-702: studio websites carry their own title, description and share image (FL-701 item 16).
      // FL-711: /studio/projects is the app's Studio project library, not a website.
      const studio = request.path.match(/^\/studio\/([a-z0-9-]{1,48})\/?$/);
      if (studio && !STUDIO_APP_PAGES.has(studio[1])) {
        try {
          meta = await this.siteService.metadataTags(studio[1], defaultDomain);
        } catch {
          status = 404;
        }
      }

      if (meta) {
        html = render(index, meta);
      }

      if (request.path === '/link') {
        // CLD-004: the page strips anything in its address at once; until then no referrer carries it
        res.header('Referrer-Policy', 'no-referrer');
      }

      res.status(status).type(responseType).header('Cache-Control', 'no-store').send(html);
    };
  }
}
