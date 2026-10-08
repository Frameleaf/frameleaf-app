import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ICloudAttachDto,
  ICloudAttachResponseDto,
  ICloudClaimDto,
  ICloudClaimReleaseDto,
  ICloudClaimReleaseResponseDto,
  ICloudClaimRenewDto,
  ICloudClaimRenewResponseDto,
  ICloudClaimResponseDto,
  ICloudCoverageDto,
  ICloudCoverageResponseDto,
  ICloudEditBaselineDto,
  ICloudEditSuccessorDto,
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
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
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

/** Claims live this long unless asked for less; renewals go up to four hours from the first. */
const CLAIM_TTL_SEC = 600;
/** An unhealthy connection hands its items to devices after this long (owner decision 3). */
export const ICLOUD_TAKEOVER_AFTER_MS = 72 * 3600 * 1000;

const holderKind = (holder: string) =>
  holder.startsWith('icloud-sync:') ? ('icloud-sync' as const) : ('device' as const);

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
export const identityMatchingEnabled = () =>
  !['false', '0', 'no', 'off'].includes((process.env.FRAMELEAF_ICLOUD_IDENTITY_MATCHING ?? '').trim().toLowerCase());

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
    @Optional() private relations?: ICloudRelationsService,
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

  discoverEditEvidence(auth: AuthDto, assetId: string) {
    return this.repository.discoverEditEvidence(auth, assetId);
  }
  async acceptEditBaseline(auth: AuthDto, dto: ICloudEditBaselineDto) {
    const decision = await this.repository.acceptEditBaseline(auth, dto);
    await this.relations?.enqueue();
    return decision;
  }
  async acceptEditSuccessor(auth: AuthDto, dto: ICloudEditSuccessorDto) {
    const decision = await this.repository.acceptEditSuccessor(auth, dto);
    await this.relations?.enqueue();
    return decision;
  }

  async coverage(auth: AuthDto, dto: ICloudCoverageDto): Promise<ICloudCoverageResponseDto> {
    // with matching switched off, nothing is proven from the identifiers (owner decision 7)
    const matching = identityMatchingEnabled();
    const samples = (matching ? dto.samples : []).flatMap((sample) => {
      const parsed = parseCloudIdentifier(sample.cloudIdentifier);
      return parsed ? [{ sample, parsed }] : [];
    });
    const connections = await this.repository.connections(auth.user.id);
    const inventory = await this.repository.inventory(
      auth.user.id,
      samples.map(({ parsed }) => parsed.cplAssetRecordName),
    );
    return {
      identityMatching: matching,
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
              ({ sample }) => !!sample.creationDate && Date.parse(sample.creationDate) < completeAt.getTime(),
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
    const [identities, inventory, connections, claims] = await Promise.all([
      matching ? this.repository.identities(auth.user.id, names) : Promise.resolve([]),
      matching ? this.repository.inventory(auth.user.id, names) : Promise.resolve([]),
      this.repository.connections(auth.user.id),
      this.repository.claims(auth.user.id, names),
    ]);
    const hashes = [...new Set(dto.items.flatMap((item) => Object.values(item.sha256ByRole ?? {})))];
    const visible = await this.visibleAssets(
      auth,
      identities.map(({ assetId }) => assetId),
      hashes,
    );
    // Delivery and audit history qualify only the current original, on both lookup paths.
    const currentIdentities = identities.filter(
      ({ assetId, sha256 }) => visible.byId.get(assetId) === sha256.toString('hex'),
    );
    const byConnection = new Map(connections.map((connection) => [connection.id, connection]));

    return {
      identityMatching: matching,
      items: items.map(({ item, parsed }) => {
        const known = parsed
          ? currentIdentities.filter((row) => row.cplAssetRecordName === parsed.cplAssetRecordName)
          : [];
        const records = parsed
          ? inventory.filter(
              (record) =>
                record.cplAssetRecordName === parsed.cplAssetRecordName &&
                isActionable(inventoryStrength(parsed, item, record)),
            )
          : [];
        const inventoryHint =
          !!parsed &&
          inventory.some(
            (record) =>
              record.cplAssetRecordName === parsed.cplAssetRecordName &&
              !isActionable(inventoryStrength(parsed, item, record)),
          );
        const covering = records.find((record) => {
          const connection = byConnection.get(record.connectionId);
          return record.inScope && connection && connectionHealth(connection) === 'healthy';
        });
        // The edit owner does not follow the connection's health: a sync that is briefly failing or
        // waiting for sign-in still imports its renders once it recovers, so handing the edits to the
        // device meanwhile would leave two renders of one edit. Moving them after 72 hours unhealthy
        // (with a watermark) is the claims slice's handover, not this lookup's.
        const editSource = [covering, ...records].find(
          (record) => record?.inScope && byConnection.get(record.connectionId)?.config.includeEdits !== false,
        );

        return {
          id: item.id,
          cplAssetRecordName: parsed?.cplAssetRecordName ?? null,
          editOwner: editSource
            ? { kind: 'icloud-sync' as const, connectionId: editSource.connectionId }
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
              claimedBy: null,
              claimExpiresAt: null,
            };
            const device = item.sha256ByRole?.[role];

            // 1. an identity on record
            const candidates = known.filter(
              (row) =>
                row.role === role &&
                (role !== 'edit-render' || !item.editVersion || row.editVersion === item.editVersion),
            );
            const version = role === 'edit-render' && !item.editVersion ? candidates.at(-1)?.editVersion : undefined;
            const rows = version === undefined ? candidates : candidates.filter((row) => row.editVersion === version);
            if (new Set(rows.map(({ assetId }) => assetId)).size > 1) {
              return { ...empty, state: 'review' as const };
            }
            const row = rows.at(-1);
            if (row?.lastAuditResult === 'mismatch') {
              return { ...empty, state: 'review' as const };
            }
            // a hint is reported (so its rate can be measured) but never acted on
            let hinted = inventoryHint;
            if (row && parsed) {
              const strength = this.strength(row, parsed, item, device, inventory);
              if (isActionable(strength)) {
                return { ...empty, ...this.onServer(row), matchStrength: strength, state: 'on-server' as const };
              }
              hinted = true;
            }
            const unknown = { ...empty, matchStrength: hinted ? ('hint' as const) : null, state: 'unknown' as const };

            // 2. the same bytes, whoever delivered them
            const byHash = device ? visible.byHash.get(device) : undefined;
            if (byHash) {
              const delivered = currentIdentities.find(({ assetId }) => assetId === byHash);
              return {
                ...empty,
                ...(delivered && this.onServer(delivered)),
                assetId: byHash,
                sha256: device!,
                matchStrength: delivered && parsed ? this.strength(delivered, parsed, item, device, inventory) : null,
                state: 'on-server' as const,
              };
            }

            // 3. a path is fetching it now
            const claim = parsed && claims.find((row) => row.cplAssetRecordName === parsed.cplAssetRecordName);
            if (claim) {
              return {
                ...empty,
                claimedBy: holderKind(claim.holder),
                claimExpiresAt: iso(claim.expiresAt),
                state: 'claimed' as const,
              };
            }

            // 4. the sync's inventory
            if (covering && role !== 'edit-render') {
              const connection = byConnection.get(covering.connectionId)!;
              // per role: the sync may bring the still but not, say, a RAW it does not import
              const pendingRole = covering.pendingRoles.includes(role);
              return pendingRole
                ? {
                    ...empty,
                    connectionId: connection.id,
                    expectedBy: iso(connection.nextRunAt),
                    pendingSince: iso(covering.pendingSince),
                    state: 'sync-pending' as const,
                  }
                : { ...unknown, connectionId: connection.id };
            }
            const outside = records.find((record) => !record.inScope);
            if (outside) {
              return { ...empty, connectionId: outside.connectionId, state: 'out-of-scope' as const };
            }
            return unknown;
          }),
        };
      }),
    };
  }

  /**
   * Claim items for this device, so only one path downloads and uploads each (all its roles). An
   * item a healthy sync connection covers is the sync's to fetch (owner decision 2); one an unhealthy
   * connection covers is the device's after 72 hours, or at once when the person asks (decision 3).
   */
  async claim(auth: AuthDto, dto: ICloudClaimDto): Promise<ICloudClaimResponseDto> {
    await this.requireDevice(auth, dto.deviceKey);
    const holder = `device:${dto.deviceKey}`;
    const items = dto.items.map((item) => ({ item, parsed: parseCloudIdentifier(item.cloudIdentifier) }));
    const names = [...new Set(items.flatMap(({ parsed }) => (parsed ? [parsed.cplAssetRecordName] : [])))];
    const [inventory, connections] = await Promise.all([
      identityMatchingEnabled() ? this.repository.inventory(auth.user.id, names) : Promise.resolve([]),
      this.repository.connections(auth.user.id),
    ]);
    const byConnection = new Map(connections.map((connection) => [connection.id, connection]));
    const now = Date.now();

    const blocked = new Map<string, { connectionId: string; takeOverAt: string | null }>();
    for (const { item, parsed } of items) {
      if (!parsed) {
        continue;
      }
      for (const record of inventory) {
        const connection = byConnection.get(record.connectionId);
        // the sync keeps an item only while it still has a resource of it on the way (the lookup's
        // sync-pending): once what is left has failed, needs review, or is not imported, the lookup
        // tells the device to deliver the missing roles, and the claim must let it
        if (
          !connection ||
          !record.inScope ||
          record.pendingRoles.length === 0 ||
          record.cplAssetRecordName !== parsed.cplAssetRecordName ||
          !isActionable(inventoryStrength(parsed, item, record))
        ) {
          continue;
        }
        if (connectionHealth(connection) === 'healthy') {
          blocked.set(parsed.cplAssetRecordName, { connectionId: connection.id, takeOverAt: null });
          break;
        }
        const since = connection.unhealthySince ? new Date(connection.unhealthySince).getTime() : now;
        const takeOverAt = since + ICLOUD_TAKEOVER_AFTER_MS;
        if (!dto.takeOver && now < takeOverAt) {
          blocked.set(parsed.cplAssetRecordName, {
            connectionId: connection.id,
            takeOverAt: iso(new Date(takeOverAt)),
          });
          break;
        }
      }
    }

    const claims = await this.repository.claim(
      auth.user.id,
      names.filter((name) => !blocked.has(name)),
      holder,
      dto.ttlSec ?? CLAIM_TTL_SEC,
    );
    return {
      items: items.map(({ item, parsed }) => {
        const answer = {
          id: item.id,
          cplAssetRecordName: parsed?.cplAssetRecordName ?? null,
          claimId: null,
          expiresAt: null,
          holder: null,
          connectionId: null,
          takeOverAt: null,
        };
        if (!parsed) {
          return { ...answer, state: 'invalid' as const };
        }
        const covered = blocked.get(parsed.cplAssetRecordName);
        if (covered) {
          return { ...answer, ...covered, state: 'sync-covers' as const };
        }
        const claim = claims.find((row) => row.cplAssetRecordName === parsed.cplAssetRecordName)!;
        return claim.holder === holder
          ? { ...answer, claimId: claim.id, expiresAt: iso(claim.expiresAt), state: 'granted' as const }
          : { ...answer, holder: holderKind(claim.holder), expiresAt: iso(claim.expiresAt), state: 'held' as const };
      }),
    };
  }

  async attach(auth: AuthDto, dto: ICloudAttachDto): Promise<ICloudAttachResponseDto> {
    await this.requireDevice(auth, dto.deviceKey);
    const items: ICloudAttachResponseDto['items'] = [];
    for (const item of dto.items) {
      const parsed = parseCloudIdentifier(item.cloudIdentifier);
      if (!parsed) {
        items.push({ id: item.id, state: 'invalid' });
        continue;
      }
      const attached = await this.repository.attachDevice(auth, {
        ownerId: auth.user.id,
        assetId: item.assetId,
        parsed,
        cloudIdentifier: item.cloudIdentifier,
        role: item.role,
        editVersion: item.role === 'edit-render' ? item.editVersion! : '',
        sha256: Buffer.from(item.sha256, 'hex'),
        deviceKey: dto.deviceKey,
        claimId: null,
        metadata: item,
      });
      items.push({ id: item.id, state: attached ? 'attached' : 'unavailable' });
    }
    return { items };
  }

  async renewClaims(auth: AuthDto, dto: ICloudClaimRenewDto): Promise<ICloudClaimRenewResponseDto> {
    await this.requireDevice(auth, dto.deviceKey);
    const rows = await this.repository.renew(
      auth.user.id,
      [...new Set(dto.claimIds)],
      `device:${dto.deviceKey}`,
      dto.ttlSec ?? CLAIM_TTL_SEC,
    );
    return { claims: rows.map((row) => ({ claimId: row.id, expiresAt: iso(row.expiresAt)! })) };
  }

  async releaseClaims(auth: AuthDto, dto: ICloudClaimReleaseDto): Promise<ICloudClaimReleaseResponseDto> {
    await this.requireDevice(auth, dto.deviceKey);
    return {
      released: await this.repository.release(auth.user.id, [...new Set(dto.claimIds)], `device:${dto.deviceKey}`),
    };
  }

  /** A device acts only as one of the caller's own registered backup devices. */
  private async requireDevice(auth: AuthDto, deviceKey: string) {
    if (!(await this.repository.ownsDevice(auth.user.id, deviceKey))) {
      throw new ForbiddenException('This device is not one of your backup devices');
    }
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
    const strength = matchStrength({
      known: row,
      reported: { ...parsed, ...(device && { sha256: Buffer.from(device, 'hex') }) },
      metadataAgrees: !!record && metadataAgrees(item, record.assetFields, record.masterFields, decodedName),
    });
    // a device's record carries the names that device sent, so they always match a later report of
    // the same item: if the record was only a hint when it was made, agreeing metadata now does not
    // make it more (the same bytes still do)
    const deviceHint = !row.deliveredBy.startsWith('icloud-sync:') && !isActionable(row.matchStrength);
    return strength === 'corroborated' && deviceHint ? 'hint' : strength;
  }

  /** The caller's assets among these, by the safety lookup's rules (FL-226), and which hold these hashes. */
  private async visibleAssets(auth: AuthDto, assetIds: string[], hashes: string[]) {
    const byId = new Map<string, string>();
    const byHash = new Map<string, string>();
    if (assetIds.length > 0) {
      const rows = await this.integrity
        .getSafetyQuery(auth)
        .where('asset.id', 'in', [...new Set(assetIds)])
        .execute();
      for (const row of rows) {
        if (row.sha256) {
          byId.set(row.id, row.sha256);
        }
      }
    }
    if (hashes.length > 0) {
      for (const row of await this.integrity.getSafetyQuery(auth, hashes).execute()) {
        if (!row.sha256) {
          continue;
        }
        byId.set(row.id, row.sha256);
        if (!byHash.has(row.sha256)) {
          byHash.set(row.sha256, row.id);
        }
      }
    }
    return { byId, byHash };
  }
}
