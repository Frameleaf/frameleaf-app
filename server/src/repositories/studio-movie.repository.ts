import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';
import { DB } from 'src/schema/index.js';
import { withHiddenContentFilter } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';
import { STUDIO_MOVIE_BEAT_SAMPLE_RATE, StudioMovieAsset } from 'src/utils/studio-movie.js';

/** A movie is made from at most this many photos and videos; the best of a larger set are used. */
export const STUDIO_MOVIE_MAX_SOURCE = 2000;
/** Videos offered as songs must run at least this long. */
export const STUDIO_MOVIE_MIN_SONG_SECONDS = 20;

export type StudioMovieSong = {
  id: string;
  type: AssetType;
  name: string;
  durationSeconds: number;
  originalPath: string;
};

const parseEmbedding = (value: unknown): number[] | null => {
  if (typeof value !== 'string' || !value.startsWith('[')) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'number') ? parsed : null;
  } catch {
    return null;
  }
};

const seconds = (milliseconds: number | null) =>
  typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : null;

const nameOf = (fileName: string) => fileName.replace(/\.[^./]+$/, '') || fileName;

/**
 * Make a movie (FL-561): what the server already knows about a source's photos and videos, and the
 * local FFmpeg work on its music. Callers have checked access to every id they pass.
 */
@Injectable()
export class StudioMovieRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The album's items, oldest first. */
  async getAlbumAssetIds(albumId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select('asset.id')
      .where('album_asset.albumId', '=', albumId)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt', 'asc')
      .limit(STUDIO_MOVIE_MAX_SOURCE * 2)
      .execute();
    return rows.map(({ id }) => id);
  }

  /** The memory's items, oldest first. */
  async getMemoryAssetIds(memoryId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('memory_asset')
      .innerJoin('asset', 'asset.id', 'memory_asset.assetId')
      .select('asset.id')
      .where('memory_asset.memoriesId', '=', memoryId)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt', 'asc')
      .limit(STUDIO_MOVIE_MAX_SOURCE * 2)
      .execute();
    return rows.map(({ id }) => id);
  }

  /**
   * The photos and videos among `ids` that may go in a movie, with what picking moments uses: Best
   * Photos scores and best video frame, favourites, ratings, visible faces and the smart search
   * embedding. Locked items, hidden items, other people's items their owner's Locked rules hide from
   * `viewerId`, and anything in the trash are left out (owner decisions FL-195, FL-446).
   */
  async getMovieAssets(ids: string[], viewerId: string): Promise<StudioMovieAsset[]> {
    if (ids.length === 0) {
      return [];
    }
    const query = this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_best_photo_score', 'asset_best_photo_score.assetId', 'asset.id')
      .leftJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.type',
        'asset.originalFileName',
        'asset.fileCreatedAt',
        'asset.isFavorite',
        'asset.duration',
        'asset_exif.rating',
        'asset_best_photo_score.score',
        'asset_best_photo_score.bestFrameTimestampMs',
        sql<string | null>`smart_search.embedding::text`.as('embedding'),
        (eb) =>
          eb
            .selectFrom('asset_face')
            .select((face) => face.fn.countAll<number>().as('count'))
            .whereRef('asset_face.assetId', '=', 'asset.id')
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true)
            .as('faceCount'),
      ])
      .where('asset.id', 'in', ids)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.type', 'in', [AssetType.Image, AssetType.Video])
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where(isNotLocked('asset'))
      .orderBy('asset.fileCreatedAt', 'asc')
      .limit(STUDIO_MOVIE_MAX_SOURCE);
    const rows = await withHiddenContentFilter(query, { othersRulesViewerId: viewerId }).execute();
    return rows.map((row) => ({
      id: row.id,
      type: row.type === AssetType.Video ? 'VIDEO' : 'IMAGE',
      fileName: row.originalFileName,
      takenAt: new Date(row.fileCreatedAt as unknown as string).toISOString(),
      isFavorite: !!row.isFavorite,
      rating: row.rating ?? null,
      durationSeconds: row.type === AssetType.Video ? seconds(row.duration) : null,
      bestScore: typeof row.score === 'number' ? row.score : null,
      bestFrameSeconds: seconds(row.bestFrameTimestampMs ?? null),
      faceCount: Number(row.faceCount ?? 0),
      embedding: parseEmbedding(row.embedding),
    }));
  }

  /**
   * Songs for a movie: the owner's audio files, then their videos long enough to lend their
   * soundtrack, newest first, optionally matching `query` in the file name.
   */
  async listSongs(ownerId: string, options: { query?: string; limit: number }): Promise<StudioMovieSong[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.type', 'asset.originalFileName', 'asset.originalPath', 'asset.duration'])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where(isNotLocked('asset'))
      .where((eb) =>
        eb.or([
          eb('asset.type', '=', AssetType.Audio),
          eb.and([
            eb('asset.type', '=', AssetType.Video),
            eb('asset.duration', '>=', STUDIO_MOVIE_MIN_SONG_SECONDS * 1000),
          ]),
        ]),
      )
      .$if(!!options.query, (qb) =>
        qb.where('asset.originalFileName', 'ilike', `%${options.query!.replaceAll(/[%_\\]/g, String.raw`\$&`)}%`),
      )
      .orderBy(sql`case when asset.type = ${AssetType.Audio} then 0 else 1 end`)
      .orderBy('asset.fileCreatedAt', 'desc')
      .limit(options.limit)
      .execute();
    return rows
      .map((row) => ({
        id: row.id,
        type: row.type,
        name: nameOf(row.originalFileName),
        durationSeconds: seconds(row.duration) ?? 0,
        originalPath: row.originalPath,
      }))
      .filter((song) => song.durationSeconds > 0);
  }

  /** One of the owner's songs (an audio file or a video), or undefined. */
  async getSong(ownerId: string, id: string): Promise<StudioMovieSong | undefined> {
    const [song] = (await this.listSongsById(ownerId, [id])) ?? [];
    return song;
  }

  private async listSongsById(ownerId: string, ids: string[]): Promise<StudioMovieSong[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.type', 'asset.originalFileName', 'asset.originalPath', 'asset.duration'])
      .where('asset.id', 'in', ids)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', 'in', [AssetType.Audio, AssetType.Video])
      .where(isNotLocked('asset'))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      name: nameOf(row.originalFileName),
      durationSeconds: seconds(row.duration) ?? 0,
      originalPath: row.originalPath,
    }));
  }

  /**
   * The first `maxSeconds` of the first audio stream of `input`, as mono float samples at the beat
   * finder's rate (`STUDIO_MOVIE_BEAT_SAMPLE_RATE`).
   */
  async decodeForBeats(input: string, maxSeconds: number, signal: AbortSignal): Promise<Float32Array> {
    const output = await this.ffmpeg(
      [
        '-i',
        input,
        '-t',
        String(maxSeconds),
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-ar',
        String(STUDIO_MOVIE_BEAT_SAMPLE_RATE),
        '-f',
        'f32le',
        'pipe:1',
      ],
      signal,
      Math.ceil(maxSeconds + 5) * STUDIO_MOVIE_BEAT_SAMPLE_RATE * 4,
    );
    return new Float32Array(output.buffer, output.byteOffset, Math.floor(output.byteLength / 4));
  }

  /**
   * The movie's music as an AAC `.m4a` (48 kHz stereo): the first audio stream of `input`, cut to its
   * first `maxSeconds`. Pictures, subtitles and metadata are dropped.
   */
  async encodeMusic(input: string, output: string, maxSeconds: number, signal: AbortSignal): Promise<void> {
    await this.ffmpeg(
      [
        '-i',
        input,
        '-t',
        String(maxSeconds),
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-f',
        'ipod',
        '-y',
        output,
      ],
      signal,
      1024 * 1024,
    );
  }

  /** The length of the first audio stream of a file, in seconds, or null when it has none. */
  async probeAudioSeconds(input: string, signal: AbortSignal): Promise<number | null> {
    signal.throwIfAborted();
    const { stdout } = await promisify(execFile)(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=duration:format=duration',
        '-of',
        'json',
        input,
      ],
      { maxBuffer: 1024 * 1024, signal },
    );
    const parsed = JSON.parse(stdout) as { streams?: Array<{ duration?: string }>; format?: { duration?: string } };
    if (!parsed.streams?.length) {
      return null;
    }
    const value = Number(parsed.streams[0].duration ?? parsed.format?.duration);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  private async ffmpeg(args: string[], signal: AbortSignal, maxBuffer: number): Promise<Buffer> {
    signal.throwIfAborted();
    const run = promisify(execFile)(
      'ffmpeg',
      ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', ...args],
      { maxBuffer, encoding: 'buffer' },
    );
    const closed = new Promise<void>((resolve) => run.child.once('close', () => resolve()));
    const lifetime = superviseMediaProcess(run.child, { signal });
    try {
      const { stdout } = await run;
      return stdout;
    } catch (error) {
      throw lifetime.error() ?? error;
    } finally {
      await closed;
    }
  }
}
