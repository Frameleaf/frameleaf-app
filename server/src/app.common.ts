import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'body-parser';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmetMiddleware from 'helmet';
import { existsSync } from 'node:fs';
import sirv from 'sirv';
import { IMMICH_SERVER_START, excludePaths, serverVersion } from 'src/constants.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { frameleafViaMiddleware } from 'src/middleware/frameleaf-via.middleware.js';
import { WebSocketAdapter } from 'src/middleware/websocket.adapter.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ApiService } from 'src/services/api.service.js';
import { useSwagger } from 'src/utils/misc.js';

export async function configureExpress(
  app: NestExpressApplication,
  {
    permitSwaggerWrite = true,
    ssr,
  }: {
    /**
     * Whether to allow swagger module to write to the specs.json
     * This is not desirable when the API is not available
     * @default true
     */
    permitSwaggerWrite?: boolean;
    /**
     * Service to use for server-side rendering
     */
    ssr: typeof ApiService | typeof MaintenanceWorkerService;
  },
) {
  const configRepository = app.get(ConfigRepository);
  const { environment, host, port, helmet, resourcePaths, network, frameleafCloud } = configRepository.getEnv();

  const logger = await app.resolve(LoggingRepository);
  logger.setContext('Bootstrap');
  app.useLogger(logger);

  app.set('trust proxy', ['loopback', ...network.trustedProxies]);
  app.set('etag', 'strong');

  if (helmet.config) {
    app.use(helmetMiddleware(helmet.config));
    logger.log('Initialized helmet middleware');
  }

  app.use(cookieParser());
  // FL-161: record how the request arrived (vouched for by the edge worker's per-boot secret) and
  // drop every client-supplied `X-Frameleaf-*` claim before anything else reads the request.
  app.use(frameleafViaMiddleware(frameleafCloud.edge.secret));
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb' }));

  if (configRepository.isDev()) {
    app.enableCors();
  }

  app.setGlobalPrefix('api', { exclude: excludePaths });
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  useSwagger(app, { write: configRepository.isDev() && permitSwaggerWrite });

  if (existsSync(resourcePaths.web.root)) {
    // copied from https://github.com/sveltejs/kit/blob/679b5989fe62e3964b9a73b712d7b41831aa1f07/packages/adapter-node/src/handler.js#L46
    // provides serving of precompressed assets and caching of immutable assets
    app.use(
      sirv(resourcePaths.web.root, {
        etag: true,
        gzip: true,
        brotli: true,
        extensions: [],
        setHeaders: (res, pathname) => {
          if (pathname.startsWith(`/_app/immutable`) && res.statusCode === 200) {
            res.setHeader('cache-control', 'public,max-age=31536000,immutable');
          }
        },
      }),
    );
  }

  app.use(app.get(ssr).ssr(excludePaths));
  app.use(compression());

  const server = await (host ? app.listen(port, host) : app.listen(port));
  server.requestTimeout = 24 * 60 * 60 * 1000;

  logger.log(`${IMMICH_SERVER_START} on ${await app.getUrl()} [v${serverVersion}] [${environment}] `);
}
