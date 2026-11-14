import { Column, ForeignKeyColumn, Index, PrimaryColumn, Table, Unique, registerFunction } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { ConnectEventType } from 'src/utils/connect-events.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { OAuthGrantTable } from 'src/schema/tables/oauth-app.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('connect_event_stream')
export class ConnectEventStreamTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'bigint', default: 0 }) position!: Generated<string>;
  @Column({ type: 'bigint', default: 0 }) prunedThrough!: Generated<string>;
}

@Table('connect_event')
@Unique({ name: 'connect_event_source_key', columns: ['ownerId', 'sourceId'] })
@Unique({ name: 'connect_event_delivery_key', columns: ['deliveryId'] })
@Index({ name: 'connect_event_retention_idx', columns: ['occurredAt'] })
export class ConnectEventTable {
  @ForeignKeyColumn(() => ConnectEventStreamTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;
  @PrimaryColumn({ type: 'bigint' }) position!: string;
  @Column({ type: 'uuid', default: () => 'gen_random_uuid()' }) deliveryId!: Generated<string>;
  @Column() sourceId!: string;
  @Column() event!: ConnectEventType;
  @Column({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'uuid', nullable: true }) albumId!: string | null;
  @Column({ type: 'uuid', nullable: true }) versionId!: string | null;
  @Column({ nullable: true }) format!: string | null;
  @Column({ type: 'timestamp with time zone', default: () => 'clock_timestamp()' }) occurredAt!: Generated<Timestamp>;
}

/** Keep the first-ready marker until asset deletion, even after the event itself ages out. */
@Table('connect_asset_ready')
export class ConnectAssetReadyTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) assetId!: string;
}

@Table('connect_event_cursor')
@Index({ name: 'connect_event_cursor_expiry_idx', columns: ['expiresAt'] })
export class ConnectEventCursorTable {
  @PrimaryColumn({ type: 'bytea' }) tokenHash!: Buffer;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false }) ownerId!: string;
  @ForeignKeyColumn(() => OAuthGrantTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false }) grantId!: string;
  @Column() binding!: string;
  @Column() mode!: 'oldest' | 'latest';
  @Column({ nullable: true }) type!: ConnectEventType | null;
  @Column({ type: 'uuid', nullable: true }) albumId!: string | null;
  @Column({ type: 'bigint' }) position!: string;
  @Column({ type: 'bigint' }) floor!: string;
  @Column({ type: 'bigint', nullable: true }) ceiling!: string | null;
  @Column({ type: 'integer', nullable: true }) remaining!: number | null;
  @Column({ type: 'timestamp with time zone' }) expiresAt!: Timestamp;
}

export const connect_event_append = registerFunction({
  name: 'connect_event_append',
  arguments: [
    'p_owner uuid',
    'p_source text',
    'p_event text',
    'p_asset uuid',
    'p_album uuid',
    'p_version uuid',
    'p_format text',
  ],
  returnType: 'void',
  language: 'PLPGSQL',
  body: `
    DECLARE next_position bigint;
    BEGIN
      INSERT INTO connect_event_stream ("ownerId") VALUES (p_owner) ON CONFLICT DO NOTHING;
      PERFORM 1 FROM connect_event_stream WHERE "ownerId"=p_owner FOR UPDATE;
      IF EXISTS (SELECT 1 FROM connect_event WHERE "ownerId"=p_owner AND "sourceId"=p_source) THEN RETURN; END IF;
      UPDATE connect_event_stream SET position=position+1 WHERE "ownerId"=p_owner RETURNING position INTO next_position;
      INSERT INTO connect_event ("ownerId",position,"sourceId",event,"assetId","albumId","versionId",format)
        VALUES (p_owner,next_position,p_source,p_event,p_asset,p_album,p_version,p_format);
    END`,
});

/** Source foreign keys already hold KEY SHARE: preserve those locks while serializing readiness. */
export const connect_event_asset_ready = registerFunction({
  name: 'connect_event_asset_ready',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    DECLARE asset_owner uuid; ready_id uuid;
    BEGIN
      IF TG_TABLE_NAME='asset_file' THEN
        IF NEW.type NOT IN ('preview','thumbnail') OR NEW."isEdited" THEN RETURN NEW; END IF;
      ELSIF TG_TABLE_NAME='asset_job_status' THEN
        -- Only a newly set metadataExtractedAt can make an asset ready; other status writes skip the asset lock.
        IF NEW."metadataExtractedAt" IS NULL THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' THEN
          IF OLD."metadataExtractedAt" IS NOT NULL THEN RETURN NEW; END IF;
        END IF;
      END IF;
      SELECT "ownerId" INTO asset_owner FROM asset WHERE id=NEW."assetId" AND type IN ('IMAGE','VIDEO') FOR NO KEY UPDATE;
      IF asset_owner IS NULL THEN RETURN NEW; END IF;
      IF EXISTS (SELECT 1 FROM asset_job_status WHERE "assetId"=NEW."assetId" AND "metadataExtractedAt" IS NOT NULL)
        AND EXISTS (SELECT 1 FROM asset_file WHERE "assetId"=NEW."assetId" AND type='preview' AND NOT "isEdited" AND path<>'')
        AND EXISTS (SELECT 1 FROM asset_file WHERE "assetId"=NEW."assetId" AND type='thumbnail' AND NOT "isEdited" AND path<>'') THEN
        INSERT INTO connect_asset_ready ("assetId") VALUES (NEW."assetId") ON CONFLICT DO NOTHING RETURNING "assetId" INTO ready_id;
        IF ready_id IS NOT NULL THEN
          PERFORM connect_event_append(asset_owner,'asset.ready:'||ready_id,'asset.ready',ready_id,NULL,NULL,NULL);
        END IF;
      END IF;
      RETURN NEW;
    END`,
});

export const connect_event_album_added = registerFunction({
  name: 'connect_event_album_added',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    DECLARE asset_owner uuid;
    BEGIN
      SELECT "ownerId" INTO asset_owner FROM asset WHERE id=NEW."assetId";
      PERFORM connect_event_append(asset_owner,'album.asset.added:'||NEW."albumId"||':'||NEW."assetId"||':'||NEW."updateId",
        'album.asset.added',NEW."assetId",NEW."albumId",NULL,NULL);
      RETURN NEW;
    END`,
});

export const connect_event_studio_published = registerFunction({
  name: 'connect_event_studio_published',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    DECLARE export_format text;
    BEGIN
      IF NEW.state<>'published' OR NEW.scope IS DISTINCT FROM 'library' OR NEW."resultAssetId" IS NULL THEN RETURN NEW; END IF;
      IF TG_OP='UPDATE' AND OLD.state='published' AND OLD.scope='library' AND OLD."resultAssetId" IS NOT NULL THEN RETURN NEW; END IF;
      export_format := CASE WHEN NEW."outputContentType" IN ('image/jpeg','image/heic','video/mp4','video/webm','video/quicktime','video/x-matroska') THEN NEW."outputContentType" ELSE NULL END;
      PERFORM connect_event_append(NEW."ownerId",'studio.export.completed:'||NEW.id,'studio.export.completed',NEW."resultAssetId",NULL,NEW.id,export_format);
      RETURN NEW;
    END`,
});
