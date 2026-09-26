import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { controllers } from 'src/controllers/index.js';
import { LivePhotoController } from 'src/controllers/live-photo.controller.js';
import { MediaHealthController } from 'src/controllers/media-health.controller.js';
import { LivePhotoRelinkDto } from 'src/dtos/live-photo.dto.js';
import {
  MediaHealthBulkActionDto,
  MediaHealthChooseCandidatesDto,
  MediaHealthDeleteCorruptDto,
  MediaHealthListQueryDto,
  MediaHealthLocateDto,
  MediaHealthRecoverDto,
  MediaHealthSummaryQueryDto,
} from 'src/dtos/media-health.dto.js';
import { MetadataKey } from 'src/enum.js';
import { AuthenticatedOptions, getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimitRule } from 'src/middleware/rate-limit.guard.js';

const UNAUTHENTICATED_ADMIN_ROUTES = new Set([
  'GET admin/maintenance/status',
  'POST admin/maintenance/login',
  'POST admin/database-backups/start-restore',
]);

/** Admin-only routes that live outside `admin/`, i.e. `@Authenticated({ admin: true })` */
const ADMIN_ROUTES = new Set([
  'DELETE libraries/:id',
  'DELETE libraries/:id/scan',
  'GET libraries/:id/removal',
  'GET libraries/managed-uploads',
  'POST libraries/:id/removal',
  'GET enrichment/options',
  'POST enrichment/preview',
  'DELETE ml-destinations/:id',
  'DELETE ml-destinations/:id/consent',
  'GET ml-destinations',
  'GET ml-destinations/:id',
  // Asks a worker which restoration models it holds; admin like the other destination reads (FL-114).
  'GET ml-destinations/:id/restoration-models',
  'GET ml-destinations/routes',
  'POST ml-destinations',
  'POST ml-destinations/:id/probe',
  'PUT ml-destinations/:id',
  'PUT ml-destinations/:id/consent',
  'PUT ml-destinations/routes/:workload',
  'GET system-config/image-description/requeue-estimate',
  'GET system-config/machine-learning/hardware',
  'GET system-config/smart-albums/reevaluate-estimate',
  'POST server/version-check',
  'POST system-config/image-description/defer-requeue',
  'POST system-config/image-description/requeue',
  'POST system-config/smart-albums/reevaluate',
  'DELETE queues/:name/jobs',
  'GET jobs',
  'GET libraries',
  'GET libraries/:id',
  'GET libraries/:id/statistics',
  'GET media-operations/statistics',
  'GET queues',
  'GET queues/:name',
  'GET queues/:name/jobs',
  'GET queues/:name/statistics',
  'GET server/statistics',
  'GET system-config',
  'GET system-config/defaults',
  'GET system-config/storage-template-options',
  'GET system-metadata/admin-onboarding',
  // FL-176: first-run setup for an existing library, owned by the administrator.
  'GET system-metadata/frameleaf-setup',
  'GET system-metadata/frameleaf-setup/library',
  'GET system-metadata/frameleaf-setup/storage',
  'GET system-metadata/reverse-geocoding-state',
  'GET system-metadata/version-check-state',
  // Lists the server's permitted import folders; only an administrator may point an import at one.
  'GET takeout/roots',
  'PATCH libraries/:id',
  'POST jobs',
  'POST libraries',
  'POST libraries/:id/scan',
  'POST libraries/:id/validate',
  'POST preservation/server-packages',
  // FL-71: the Job manager's Retry failed.
  'POST queues/:name/jobs/retry-failed',
  'POST system-metadata/admin-onboarding',
  'POST system-metadata/frameleaf-setup/finish',
  'PUT jobs/:name',
  'PUT libraries/:id',
  'PUT queues/:name',
  'PUT system-config',
  'PUT system-metadata/frameleaf-setup',
]);

/** Routes a shared link (`?key=`) is allowed to reach, i.e. `@Authenticated({ sharedLink: true })` */
const SHARED_LINK_ROUTES = new Set([
  'DELETE assets/:id/video/stream/:sessionId',
  'GET albums/:id',
  'GET albums/:id/map-markers',
  'GET assets/:id',
  'GET assets/:id/original',
  'GET assets/:id/thumbnail',
  'GET assets/:id/video/playback',
  'GET assets/:id/video/stream/:sessionId/:variantIndex/:filename',
  'GET assets/:id/video/stream/:sessionId/:variantIndex/playlist.m3u8',
  'GET assets/:id/video/stream/main.m3u8',
  'GET shared-links/me',
  'GET timeline/bucket',
  'GET timeline/buckets',
  // FL-33: curated cards for the same album-scoped request as the buckets; places follow showExif
  'GET timeline/highlights',
  'POST assets',
  'POST download/archive',
  'POST download/info',
  'POST search/metadata',
  'POST shared-links/login',
]);

/**
 * FL-161: the routes that send originals, archives or database backups, refused over the relay unless
 * an administrator allows them. Thumbnails, previews and playback are deliberately not here.
 */
const ORIGINAL_TRANSFER_ROUTES = new Set([
  'GET assets/:id/original',
  'POST download/archive',
  'GET admin/database-backups/:filename',
  'GET preservation/packages/:id/download',
  // full-resolution masters, bundles, renders and archives, as large as originals
  'GET assets/:id/edit-versions/:versionId/download',
  'GET studio/bundles/exports/:id/download',
  'GET studio/exports/:id/download',
  'GET memories/exports/:id/download',
  // the flagged file itself, usually an original
  'GET admin/integrity/report/:id/file',
]);

/**
 * FL-161: media routes deliberately left available through the relay: what a viewer needs to browse
 * and play (thumbnails and previews; a full-size view falls back to the preview there), and small
 * derived files.
 */
const RELAY_MEDIA_ROUTES = [
  'GET assets/:id/thumbnail',
  'GET assets/:id/video/playback',
  'GET assets/:id/video/stream/main.m3u8',
  'GET people/:id/thumbnail',
  'GET preservation/packages/:id/manifest',
  'GET users/:id/profile-image',
];

/** FL-161: the rate-limited sign-in and Frameleaf Cloud routes, by rule. */
const RATE_LIMITED_ROUTES: Record<string, RateLimitRule> = {
  'POST auth/login': RATE_LIMITS.login,
  'POST oauth/callback': RATE_LIMITS.oauthCallback,
  'POST oauth/link': RATE_LIMITS.oauthCallback,
  'POST oauth/frameleaf/authorize': RATE_LIMITS.frameleafSignIn,
  'POST oauth/frameleaf/callback': RATE_LIMITS.frameleafSignIn,
  'POST oauth/frameleaf/handoff': RATE_LIMITS.frameleafSignIn,
  'POST oauth/frameleaf/handoff/redeem': RATE_LIMITS.frameleafSignIn,
  'GET oauth/frameleaf/link': RATE_LIMITS.frameleafSignIn,
  'POST oauth/frameleaf/link': RATE_LIMITS.frameleafSignIn,
  'DELETE oauth/frameleaf/link': RATE_LIMITS.frameleafSignIn,
  'POST shared-links/login': RATE_LIMITS.sharedLinkLogin,
  'PUT admin/license/activate': RATE_LIMITS.licenseActivation,
  'PUT admin/license/certificate': RATE_LIMITS.licenseActivation,
  'PUT users/me/license': RATE_LIMITS.licenseActivation,
  'POST admin/cloud/link': RATE_LIMITS.linkStart,
};

const isAdminPermission = (permission: AuthenticatedOptions['permission']) =>
  typeof permission === 'string' && permission.startsWith('admin');

const getRoutes = () => {
  const reflector = new Reflector();

  return controllers.flatMap((Controller) => {
    const prefix = reflector.get<string>(PATH_METADATA, Controller);

    return Object.getOwnPropertyNames(Controller.prototype).flatMap((name) => {
      const handler = Object.getOwnPropertyDescriptor(Controller.prototype, name)?.value;
      if (typeof handler !== 'function') {
        return [];
      }

      const requestMethod = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler);
      if (requestMethod === undefined) {
        return [];
      }

      const method = RequestMethod[requestMethod];
      const path = [prefix, reflector.get<string>(PATH_METADATA, handler)].filter((part) => part !== '/').join('/');

      return {
        id: `${method} ${path}`,
        label: `${Controller.name}.${name} (${method} /${path})`,
        path,
        auth: getAuthenticatedOptions(reflector, handler),
        originalTransfer: reflector.get<boolean | undefined>(MetadataKey.OriginalTransfer, handler) === true,
        homeNetworkOnly:
          reflector.getAllAndOverride<boolean | undefined>(MetadataKey.HomeNetworkOnly, [handler, Controller]) === true,
        rateLimit: reflector.get<RateLimitRule | undefined>(MetadataKey.RateLimit, handler),
      };
    });
  });
};

describe('controllers', () => {
  const routes = getRoutes();

  it('should only allow non-admin access to bootstrap routes under admin/', () => {
    const adminRoutes = routes.filter((route) => route.path === 'admin' || route.path.startsWith('admin/'));
    const reachableByNonAdmins = adminRoutes.filter((route) => !route.auth?.admin).map((route) => route.id);

    expect(new Set(reachableByNonAdmins)).toEqual(UNAUTHENTICATED_ADMIN_ROUTES);
  });

  it('should declare authentication on every route', () => {
    const undeclared = routes.filter((route) => route.auth === undefined).map((route) => route.label);

    expect(undeclared).toEqual([]);
  });

  it('should only allow shared link access to expected routes', () => {
    const sharedLinkRoutes = routes.filter((route) => route.auth?.sharedLink).map((route) => route.id);

    expect(new Set(sharedLinkRoutes)).toEqual(SHARED_LINK_ROUTES);
  });

  it('should only require admin access on expected routes outside /admin', () => {
    const adminRoutes = routes
      .filter((route) => route.auth?.admin && route.path !== 'admin' && !route.path.startsWith('admin/'))
      .map((route) => route.id);

    expect(new Set(adminRoutes)).toEqual(ADMIN_ROUTES);
  });

  it('should mark exactly the original, archive and backup downloads as refused over the relay (FL-161)', () => {
    const marked = routes.filter((route) => route.originalTransfer).map((route) => route.id);

    expect(new Set(marked)).toEqual(ORIGINAL_TRANSFER_ROUTES);
    for (const id of RELAY_MEDIA_ROUTES) {
      expect(routes.find((route) => route.id === id)).toMatchObject({
        originalTransfer: false,
        homeNetworkOnly: false,
      });
    }
  });

  it('should keep the whole render-worker API, original inputs included, on the home network (FL-161)', () => {
    const workerRoutes = routes.filter((route) => route.path.startsWith('render-workers/'));

    expect(workerRoutes.map((route) => route.id)).toContain('GET render-workers/operations/:id/inputs/:grant');
    expect(workerRoutes.filter((route) => !route.homeNetworkOnly)).toEqual([]);
    expect(routes.filter((route) => route.homeNetworkOnly && !route.path.startsWith('render-workers/'))).toEqual([]);
  });

  it('should rate limit sign-in, licence activation and link start (FL-161)', () => {
    const limited = Object.fromEntries(
      routes.filter((route) => route.rateLimit).map((route) => [route.id, route.rateLimit]),
    );

    expect(limited).toEqual(RATE_LIMITED_ROUTES);
  });

  it('should require admin access for routes with an admin permission', () => {
    const offenders = routes
      .filter((route) => isAdminPermission(route.auth?.permission) && !route.auth?.admin)
      .map((route) => route.label);

    expect(offenders).toEqual([]);
  });
});

describe('request DTO runtime metadata', () => {
  it.each([
    [MediaHealthController, 'list', MediaHealthListQueryDto],
    [MediaHealthController, 'getSummary', MediaHealthSummaryQueryDto],
    [MediaHealthController, 'locateMissing', MediaHealthLocateDto],
    [MediaHealthController, 'chooseCandidates', MediaHealthChooseCandidatesDto],
    [MediaHealthController, 'recoverDamaged', MediaHealthRecoverDto],
    [MediaHealthController, 'relinkMissing', MediaHealthBulkActionDto],
    [MediaHealthController, 'dismiss', MediaHealthBulkActionDto],
    [MediaHealthController, 'deleteCorrupt', MediaHealthDeleteCorruptDto],
    [LivePhotoController, 'relinkLivePhotos', LivePhotoRelinkDto],
  ] as const)('should retain %s.%s request validation and OpenAPI schema', (controller, method, dto) => {
    // Nest's reflect-metadata extension stores the runtime parameter constructors.
    // eslint-disable-next-line unicorn/no-nonstandard-builtin-properties
    expect(Reflect.getMetadata('design:paramtypes', controller.prototype, method)[1]).toBe(dto);
  });
});
