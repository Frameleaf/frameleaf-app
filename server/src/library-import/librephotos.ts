import { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-sqlite.json' with { type: 'json' };
import { sqliteSchemaFingerprint } from 'src/library-import/sqlite.js';

// Wildcards are limited to content-only tables in the exact fingerprinted schema.
const projections = {
  api_file: '*',
  api_filecopy: '*',
  api_file_embedded_media: '*',
  api_photo_files: '*',
  api_photometadata: '*',
  api_photo_caption: '*',
  api_metadataedit: '*',
  api_albumuser: '*',
  api_albumuser_photos: '*',
  api_albumuser_shared_to: '*',
  api_photo_shared_to: '*',
  api_libraryfolder: '*',
  api_libraryshare: '*',
  api_person: '*',
  api_personshare: '*',
  api_personsharephoto: '*',
  api_persongroup: '*',
  api_person_groups: '*',
  api_face_rejected_persons: '*',
  api_photostack: '*',
  api_photo_stacks: '*',
  api_tag: '*',
  api_tag_photos: '*',
  api_albumcollection: '*',
  api_albumcollection_albums: '*',
  api_albumauto: '*',
  api_albumauto_photos: '*',
  api_albumauto_shared_to: '*',
  api_albumdate: '*',
  api_albumdate_photos: '*',
  api_albumdate_shared_to: '*',
  api_albumplace: '*',
  api_albumplace_photos: '*',
  api_albumplace_shared_to: '*',
  api_albumthing: '*',
  api_albumthing_photos: '*',
  api_albumthing_cover_photos: '*',
  api_albumthing_shared_to: '*',
  api_userplace: '*',
  api_userplace_photos: '*',
  api_albumcomment: '*',
  api_albumlike: '*',
  api_duplicate: '*',
  api_photo_duplicates: '*',
  api_deletionlog: '*',
  api_photo_ocr: '*',
  api_user:
    'id,username,first_name,last_name,email,is_active,date_joined,scan_directory,favorite_min_rating,rating_mode,datetime_rules,default_timezone,public_sharing,public_sharing_defaults,share_people_names,in_public_gallery',
  api_photo:
    'image_hash,added_on,exif_gps_lat,exif_gps_lon,exif_timestamp,exif_json,geolocation_json,hidden,public,owner_id,video,rating,video_length,timestamp,size,main_file_id,last_modified,in_trashcan,removed,perceptual_hash,exif_timestamp_subsec,image_sequence_number,id,local_orientation,is_screenshot,is_document,category_source,video_codec,video_color_transfer,video_container,video_pixel_format,metadata_read_at,faces_scanned_at,geocoded_lat,geocoded_lon,location_source,trashed_at,archived,exif_timestamp_offset,exif_timestamp_source,ocr_failures,projection_type,town',
  api_face:
    'id,cluster_probability,location_top,location_bottom,location_left,location_right,person_id,photo_id,cluster_id,classification_probability,deleted,classification_person_id,cluster_person_id,video_time,unmatched_by',
  api_photoshare: 'id,enabled,created_at,photo_id',
  api_albumusershare:
    'id,enabled,expires_at,album_id,share_location,share_camera_info,share_timestamps,share_captions,share_faces',
} as const;
export type LibrephotosTable = keyof typeof projections;
export type LibrephotosRow = Record<string, SQLOutputValue>;

class LibrephotosReadError extends Error {
  constructor(readonly code: string) {
    super(`LibrePhotos source refused: ${code}`);
  }
}

/** Reads a privately captured snapshot; source identity and file consistency remain caller obligations. */
export const openLibrephotosSnapshot = (path: string, version: string) => {
  if (version !== fixture.source.version) throw new LibrephotosReadError('LIBREPHOTOS_VERSION_UNQUALIFIED');
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new LibrephotosReadError('LIBREPHOTOS_SNAPSHOT_UNAVAILABLE');
  }
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    if (sqliteSchemaFingerprint(database) !== fixture.schemaSha256) {
      throw new LibrephotosReadError('LIBREPHOTOS_SCHEMA_UNQUALIFIED');
    }
    const required = new Set(fixture.migrations.map(({ app, name }) => JSON.stringify([app, name])));
    for (const row of database.prepare('SELECT app,name,applied FROM django_migrations').iterate()) {
      const key = JSON.stringify([row.app, row.name]);
      if (
        !required.delete(key) ||
        typeof row.applied !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}[ T]/.test(row.applied) ||
        !Number.isFinite(Date.parse(row.applied))
      ) {
        throw new LibrephotosReadError('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
      }
    }
    if (required.size > 0) throw new LibrephotosReadError('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
    if (database.prepare('PRAGMA foreign_key_check').get()) {
      throw new LibrephotosReadError('LIBREPHOTOS_RELATIONSHIPS_INVALID');
    }
  } catch (error) {
    database.close();
    if (error instanceof LibrephotosReadError) throw error;
    throw new LibrephotosReadError('LIBREPHOTOS_SNAPSHOT_UNAVAILABLE');
  }
  return {
    version,
    schemaSha256: fixture.schemaSha256,
    *rows(table: LibrephotosTable): Generator<LibrephotosRow[]> {
      if (!Object.hasOwn(projections, table)) throw new LibrephotosReadError('LIBREPHOTOS_TABLE_NOT_ALLOWED');
      try {
        const select = `SELECT rowid AS __frameleaf_cursor,${projections[table]} FROM "${table}"`;
        const first = database.prepare(`${select} ORDER BY rowid LIMIT 1000`);
        first.setReadBigInts(true);
        const next = database.prepare(`${select} WHERE rowid>? ORDER BY rowid LIMIT 1000`);
        next.setReadBigInts(true);
        let batch = first.all();
        while (batch.length > 0) {
          const cursor = batch.at(-1)!.__frameleaf_cursor;
          yield batch.map(({ __frameleaf_cursor: _cursor, ...row }) => row);
          batch = next.all(cursor);
        }
      } catch {
        throw new LibrephotosReadError('LIBREPHOTOS_SNAPSHOT_READ_FAILED');
      }
    },
    close: () => database.close(),
  };
};
