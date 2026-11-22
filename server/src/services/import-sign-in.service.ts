import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import {
  ImportSignInAvailabilityResponseDto,
  ImportSignInCompleteDto,
  ImportSignInCompleteResponseDto,
  ImportSignInStartDto,
  ImportSignInStartResponseDto,
} from 'src/dtos/import-sign-in.dto.js';
import { type BrokerService, ProviderSignInBroker, isBrokerService } from 'src/import-connectors/broker-sign-in.js';
import { dropboxRemoteSourceProvider } from 'src/import-connectors/dropbox.source.js';
import {
  RemoteSourceError,
  type RemoteSourceProvider,
  registerRemoteSource,
  remoteSourceProvider,
} from 'src/import-connectors/remote-source.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { ImportConnectorRepository } from 'src/repositories/import-connector.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { readImportCredentials, sealImportCredentials } from 'src/utils/import-connector.js';

/**
 * Connecting a file provider by signing in (FL-959). Generic over the provider: one that sets
 * `signIn` gets these routes, so OneDrive and Google Drive add a source and a registration line.
 * The stored credentials are `{ refreshToken, accountId, accountName }`, sealed, and never answered.
 */
@Injectable()
export class ImportSignInService {
  private broker: ProviderSignInBroker;

  constructor(
    private logger: LoggingRepository,
    private repository: ImportConnectorRepository,
    private cryptoRepository: CryptoRepository,
    private configRepository: ConfigRepository,
    databaseRepository: DatabaseRepository,
    systemMetadataRepository: SystemMetadataRepository,
    instanceIdentityRepository: InstanceIdentityRepository,
    frameleafCloudRepository: FrameleafCloudRepository,
  ) {
    this.logger.setContext(ImportSignInService.name);
    this.broker = new ProviderSignInBroker({
      configRepository,
      cryptoRepository,
      databaseRepository,
      systemMetadataRepository,
      instanceIdentityRepository,
      frameleafCloudRepository,
    });
  }

  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    registerRemoteSource(dropboxRemoteSourceProvider(this.broker));
  }

  async availability(provider: string): Promise<ImportSignInAvailabilityResponseDto> {
    return this.broker.availability(this.signInOf(provider).service);
  }

  async start(auth: AuthDto, provider: string, dto: ImportSignInStartDto): Promise<ImportSignInStartResponseDto> {
    this.requireSession(auth);
    const { service } = this.signInOf(provider);
    if (dto.connectionId) {
      await this.findOwned(auth, dto.connectionId, provider);
    }
    return this.answering(() => this.broker.start(service, { userId: auth.user.id, connectionId: dto.connectionId }));
  }

  async complete(
    auth: AuthDto,
    provider: string,
    dto: ImportSignInCompleteDto,
  ): Promise<ImportSignInCompleteResponseDto> {
    this.requireSession(auth);
    const source = remoteSourceProvider(provider);
    const { service, label, account } = this.signInOf(provider);
    return this.answering(async () => {
      const result = await this.broker.finish(service, auth.user.id, dto.signInToken);
      if (result.state !== 'ready') {
        return { state: result.state, connectionId: null };
      }
      const who = await account(result.tokens.accessToken);
      const credentials = { refreshToken: result.tokens.refreshToken, accountId: who.id, accountName: who.name };

      if (result.connectionId) {
        const connection = await this.findOwned(auth, result.connectionId, provider);
        const current = await readImportCredentials(this.sealDeps, connection);
        if (current && current.accountId !== who.id) {
          // Its cursor and file ids belong to the first account. The access just granted is not kept.
          await this.giveBack(source, credentials);
          throw new RemoteSourceError(
            `That is a different ${label} account. Sign in with the one this connection uses.`,
          );
        }
        await this.repository.update(connection.id, {
          sealedCredentials: await sealImportCredentials(this.sealDeps, connection.id, credentials),
        });
        this.logger.log(`Import connection ${connection.id} (${provider}) signed in again`);
        return { state: 'connected', connectionId: connection.id };
      }

      const id = this.cryptoRepository.randomUUID();
      await this.repository.create({
        id,
        ownerId: auth.user.id,
        provider,
        displayName: dto.displayName ?? `${label} (${who.name})`.slice(0, 200),
        sealedCredentials: await sealImportCredentials(this.sealDeps, id, credentials),
        roots: dto.roots,
        dailyCheck: dto.dailyCheck,
      });
      this.logger.log(`Import connection ${id} (${provider}) created by signing in`);
      return { state: 'connected', connectionId: id };
    });
  }

  private get sealDeps() {
    return { crypto: this.cryptoRepository, config: this.configRepository };
  }

  private async giveBack(source: RemoteSourceProvider | undefined, credentials: Record<string, unknown>) {
    try {
      await source?.revoke?.(credentials);
    } catch (error) {
      this.logger.warn(`A sign-in was not revoked at the source (${error instanceof Error ? error.name : 'error'})`);
    }
  }

  private signInOf(provider: string) {
    const signIn = remoteSourceProvider(provider)?.signIn;
    if (!signIn || !isBrokerService(signIn.service)) {
      throw new BadRequestException('This kind of connection does not sign in');
    }
    return { ...signIn, service: signIn.service as BrokerService };
  }

  private requireSession(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Imports are not available on a shared link');
    }
  }

  private async findOwned(auth: AuthDto, id: string, provider: string) {
    const connection = await this.repository.get(auth.user.id, id);
    if (!connection || connection.provider !== provider) {
      throw new NotFoundException('Connection not found');
    }
    return connection;
  }

  /** Only what a source or the broker chose to say reaches the owner; anything else could quote a request. */
  private async answering<T>(ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof RemoteSourceError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.warn(`A provider sign-in failed (${error instanceof Error ? error.name : 'error'})`);
      throw new BadRequestException('The sign-in could not be finished. Start again.');
    }
  }
}
