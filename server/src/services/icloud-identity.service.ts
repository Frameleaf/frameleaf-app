import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ICloudCoverageDto,
  ICloudCoverageResponseDto,
  ICloudLookupDto,
  ICloudLookupResponseDto,
} from 'src/dtos/icloud-identity.dto.js';
import {
  ICloudCoverageConnection,
  ICloudIdentityRepository,
  ICloudIdentityRow,
  ICloudInventoryItem,
} from 'src/repositories/icloud-identity.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  ItemMetadata,
  MatchStrength,
  ParsedCloudIdentifier,
  isActionable,
  matchStrength,
  metadataAgrees,
  parseCloudIdentifier,
} from 'src/utils/icloud-identity.js';
import { decodedName } from 'src/utils/icloud-records.js';

/** The coverage probe's rule: enough samples, and nearly all of them in the inventory. */
const COVERAGE_MIN_SAMPLES = 20;
const COVERAGE_MIN_RATIO = 0.95;

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

/** A connection's state, as the app explains it. */
export const connectionHealth = (connection: Pick<ICloudCoverageConnection, 'state'>) => {
  switch (connection.state) {
    case 'connected': {
      return 'healthy' as const;
    }
    case 'paused': {
      return 'paused' as const;
    }
    case 'awaiting-device-approval': {
      return 'device-approval-required' as const;
    }
    case 'reauthentication-required':
    case 'awaiting-2fa':
    case 'authenticating': {
      return 'reauthentication-required' as const;
    }
    case 'disconnected': {
      return 'disconnected' as const;
    }
    default: {
      return 'failing' as const;
    }
  }
};

/**
 * Identity matching can be switched off (`FRAMELEAF_ICLOUD_IDENTITY_MATCHING=false`) if the
 * live-account spike shows the `PHCloudIdentifier` parse does not hold (owner decision 7): then
 * only SHA-256 matches count.
 */
export const identityMatchingEnabled = () => process.env.FRAMELEAF_ICLOUD_IDENTITY_MATCHING !== 'false';

/** How well a device's item matches an inventory record: corroborated at best, as no bytes were compared. */
const inventoryStrength = (
  parsed: ParsedCloudIdentifier,
  item: ItemMetadata,
  record: ICloudInventoryItem,
): MatchStrength =>
  matchStrength({
    known: {
      cplAssetRecordName: record.cplAssetRecordName,
      cplMasterRecordName: record.cplMasterRecordName,
      appleFingerprint: null,
      sha256: Buffer.alloc(0),
    },
    reported: parsed,
    metadataAgrees: metadataAgrees(item, record.assetFields, record.masterFields, decodedName),
  });

/**
 * FL-296 (NAPI-014): what the server knows about iCloud items, so the native app and iCloud Photos
 * Sync never both download one. Answers cover only the caller's own connections and assets, with
 * the same Locked and hidden rules as the safety lookup (FL-226).
 */
@Injectable()
export class ICloudIdentityService {
  constructor(
    private repository: ICloudIdentityRepository,
    private integrity: IntegrityRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ICloudIdentityService.name);
  }

  /**
   * Identities for everything the sync imported before they existed, and none for assets that are
   * gone. Both are idempotent, and refused (and retried the next night) during a handover.
   */
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup() {
    try {
      const recorded = await this.repository.backfill();
      const removed = await this.repository.removeOrphans();
      if (recorded > 0 || removed > 0) {
        this.logger.log(
          `iCloud identities: ${recorded} recorded from past imports, ${removed} of removed assets dropped`,
        );
      }
    } catch (error) {
      this.logger.warn(`iCloud identity upkeep deferred: ${error}`);
    }
  }

  async coverage(auth: AuthDto, dto: ICloudCoverageDto): Promise<ICloudCoverageResponseDto> {
    const samples = dto.samples.flatMap((sample) => {
      const parsed = parseCloudIdentifier(sample.cloudIdentifier);
      return parsed ? [{ sample, parsed }] : [];
    });
    const connections = await this.repository.connections(auth.user.id);
    const inventory = await this.repository.inventory(
      auth.user.id,
      samples.map(({ parsed }) => parsed.cplAssetRecordName),
    );
    return {
      connections: connections.map((connection) => {
        const completeAt = connection.lastCompleteInventoryAt ? new Date(connection.lastCompleteInventoryAt) : null;
        const records = new Map(
          inventory
            .filter((record) => record.connectionId === connection.id && record.inScope)
            .map((record) => [record.cplAssetRecordName, record]),
        );
        // only what existed before the last complete inventory can be expected in it
        const sampled = completeAt
          ? samples.filter(
              ({ sample }) => !sample.creationDate || Date.parse(sample.creationDate) < completeAt.getTime(),
            )
          : [];
        const matched = sampled.filter(({ sample, parsed }) => {
          const record = records.get(parsed.cplAssetRecordName);
          return !!record && isActionable(inventoryStrength(parsed, sample, record));
        }).length;
        const libraries = connection.config.libraries ?? [];
        const albums = connection.config.albums ?? [];
        return {
          connectionId: connection.id,
          label: connection.label,
          account: connection.accountHint,
          state: connectionHealth(connection),
          unhealthySince: iso(connection.unhealthySince),
          scope: { kind: albums.length > 0 ? 'albums' : 'libraries', libraries, albums },
          includeEdits: connection.config.includeEdits ?? true,
          lastCompleteInventoryAt: iso(completeAt),
          nextRunAt: iso(connection.nextRunAt),
          sampled: sampled.length,
          matched,
          covers: sampled.length >= COVERAGE_MIN_SAMPLES && matched >= COVERAGE_MIN_RATIO * sampled.length,
        };
      }),
    };
  }

  async lookup(auth: AuthDto, dto: ICloudLookupDto): Promise<ICloudLookupResponseDto> {
    const matching = identityMatchingEnabled();
    const items = dto.items.map((item) => ({ item, parsed: parseCloudIdentifier(item.cloudIdentifier) }));
    const names = [...new Set(items.flatMap(({ parsed }) => (parsed ? [parsed.cplAssetRecordName] : [])))];
    const [identities, inventory, connections] = await Promise.all([
      matching ? this.repository.identities(auth.user.id, names) : Promise.resolve([]),
      matching ? this.repository.inventory(auth.user.id, names) : Promise.resolve([]),
      this.repository.connections(auth.user.id),
    ]);
    const hashes = [...new Set(dto.items.flatMap((item) => Object.values(item.sha256ByRole ?? {})))];
    const visible = await this.visibleAssets(
      auth,
      identities.map(({ assetId }) => assetId),
      hashes,
    );
    const byConnection = new Map(connections.map((connection) => [connection.id, connection]));

    return {
      identityMatching: matching,
      items: items.map(({ item, parsed }) => {
        const known = parsed ? identities.filter((row) => row.cplAssetRecordName === parsed.cplAssetRecordName) : [];
        const records = parsed
          ? inventory.filter(
              (record) =>
                record.cplAssetRecordName === parsed.cplAssetRecordName &&
                isActionable(inventoryStrength(parsed, item, record)),
            )
          : [];
        const covering = records.find((record) => {
          const connection = byConnection.get(record.connectionId);
          return record.inScope && connection && connectionHealth(connection) === 'healthy';
        });
        const editsBySync = covering && byConnection.get(covering.connectionId)?.config.includeEdits !== false;

        return {
          id: item.id,
          cplAssetRecordName: parsed?.cplAssetRecordName ?? null,
          editOwner: editsBySync
            ? { kind: 'icloud-sync' as const, connectionId: covering.connectionId }
            : { kind: 'device' as const, connectionId: null },
          roles: item.roles.map((role) => {
            const empty = {
              role,
              assetId: null,
              sha256: null,
              deliveredBy: null,
              lastVerifiedAt: null,
              auditVerifiedAt: null,
              matchStrength: null,
              connectionId: null,
              expectedBy: null,
              pendingSince: null,
            };
            const device = item.sha256ByRole?.[role];

            // 1. an identity on record
            const candidates = known.filter(
              (row) =>
                row.role === role &&
                visible.ids.has(row.assetId) &&
                (role !== 'edit-render' || !item.editVersion || row.editVersion === item.editVersion),
            );
            const version = role === 'edit-render' && !item.editVersion ? candidates.at(-1)?.editVersion : undefined;
            const rows = version === undefined ? candidates : candidates.filter((row) => row.editVersion === version);
            if (new Set(rows.map(({ assetId }) => assetId)).size > 1) {
              return { ...empty, state: 'review' as const };
            }
            const row = rows.at(-1);
            if (row && parsed) {
              const strength = this.strength(row, parsed, item, device, inventory);
              if (isActionable(strength)) {
                return { ...empty, ...this.onServer(row), matchStrength: strength, state: 'on-server' as const };
              }
            }

            // 2. the same bytes, whoever delivered them
            const byHash = device ? visible.byHash.get(device) : undefined;
            if (byHash) {
              const delivered = identities.find(({ assetId }) => assetId === byHash);
              return {
                ...empty,
                ...(delivered && this.onServer(delivered)),
                assetId: byHash,
                sha256: device!,
                matchStrength: delivered && parsed ? this.strength(delivered, parsed, item, device, inventory) : null,
                state: 'on-server' as const,
              };
            }

            // 3. the sync's inventory
            if (covering && role !== 'edit-render') {
              const connection = byConnection.get(covering.connectionId)!;
              return covering.pending
                ? {
                    ...empty,
                    connectionId: connection.id,
                    expectedBy: iso(connection.nextRunAt),
                    pendingSince: iso(covering.pendingSince),
                    state: 'sync-pending' as const,
                  }
                : { ...empty, connectionId: connection.id, state: 'unknown' as const };
            }
            const outside = records.find((record) => !record.inScope);
            if (outside) {
              return { ...empty, connectionId: outside.connectionId, state: 'out-of-scope' as const };
            }
            return { ...empty, state: 'unknown' as const };
          }),
        };
      }),
    };
  }

  private onServer(row: ICloudIdentityRow) {
    return {
      assetId: row.assetId,
      sha256: row.sha256.toString('hex'),
      deliveredBy: row.deliveredBy,
      lastVerifiedAt: iso(row.lastVerifiedAt),
      auditVerifiedAt: row.lastAuditResult === 'match' ? iso(row.lastVerifiedAt) : null,
    };
  }

  private strength(
    row: ICloudIdentityRow,
    parsed: ParsedCloudIdentifier,
    item: ItemMetadata,
    device: string | undefined,
    inventory: ICloudInventoryItem[],
  ): MatchStrength {
    const record = inventory.find(({ cplAssetRecordName }) => cplAssetRecordName === row.cplAssetRecordName);
    return matchStrength({
      known: row,
      reported: { ...parsed, ...(device && { sha256: Buffer.from(device, 'hex') }) },
      metadataAgrees: !!record && metadataAgrees(item, record.assetFields, record.masterFields, decodedName),
    });
  }

  /** The caller's assets among these, by the safety lookup's rules (FL-226), and which hold these hashes. */
  private async visibleAssets(auth: AuthDto, assetIds: string[], hashes: string[]) {
    const ids = new Set<string>();
    const byHash = new Map<string, string>();
    if (assetIds.length > 0) {
      const rows = await this.integrity
        .getSafetyQuery(auth)
        .where('asset.id', 'in', [...new Set(assetIds)])
        .execute();
      for (const row of rows) {
        ids.add(row.id);
      }
    }
    if (hashes.length > 0) {
      for (const row of await this.integrity.getSafetyQuery(auth, hashes).execute()) {
        if (row.sha256 && !byHash.has(row.sha256)) {
          byHash.set(row.sha256, row.id);
        }
      }
    }
    return { ids, byHash };
  }
}
