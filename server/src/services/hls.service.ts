import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import { HLS_SEGMENT_DURATION, HLS_SEGMENT_FILENAME_REGEX, HLS_VARIANTS, HLS_VERSION } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { CacheControl, FrameleafWorker, Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PendingEvents } from 'src/utils/event.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { getCodecString, getOutputSize } from 'src/utils/media.js';

type AssetWithStreamInfo = { videoStream: VideoStreamInfo & { timeBase: number }; packets: VideoPacketInfo };
type Segmentation = { fps: number; framesPerSegment: number; segmentCount: number; segmentDuration: number };
type ApiSession = { lastRequestedSegment: number | null; lastVariantIndex: number | null };

@Injectable()
export class HlsService extends BaseService {
  private pendingSegments = new PendingEvents<'HlsSegmentResult'>({ timeoutMs: 15_000 });
  private pendingSessions = new PendingEvents<'HlsSessionResult'>({ timeoutMs: 5000 });
  private sessions = new Map<string, ApiSession>();

  @OnEvent({ name: 'HlsSessionResult', server: true, workers: [FrameleafWorker.Api] })
  onSessionResult(event: ArgOf<'HlsSessionResult'>) {
    this.pendingSessions.complete(event.sessionId, event);
    if (event.error) {
      this.sessions.delete(event.sessionId);
      this.pendingSegments.rejectByPrefix(`${event.sessionId}:`, event.error);
    }
  }

  @OnEvent({ name: 'HlsSessionEnd', server: true, workers: [FrameleafWorker.Api] })
  onSessionEnd({ sessionId }: ArgOf<'HlsSessionEnd'>) {
    this.sessions.delete(sessionId);
    this.pendingSegments.rejectByPrefix(`${sessionId}:`, 'Session ended');
  }

  @OnEvent({ name: 'HlsSegmentResult', server: true, workers: [FrameleafWorker.Api] })
  onSegmentResult(event: ArgOf<'HlsSegmentResult'>) {
    this.pendingSegments.complete(this.getSegmentKey(event), event);
  }

  async getMainPlaylist(auth: AuthDto, assetId: string) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });
    const { ffmpeg } = await this.getConfig({ withCache: true });
    if (!ffmpeg.realtime.enabled) {
      throw new BadRequestException('Real-time transcoding is not enabled');
    }
    // FL-721 (spec §8.1): HLS writes segments to disk, so an encrypted Locked video is played from
    // its encoded MP4 by range instead, decrypted as it is sent (`playbackVideo`). A partner's copy is
    // outside the encryption set but reads its owner's sealed original, so the file itself is checked too
    if (
      (await this.assetRepository.getLockedEncryptionItems([assetId])).length > 0 ||
      (await this.isSealedOriginal(assetId))
    ) {
      throw new BadRequestException('Real-time transcoding is off for encrypted Locked videos; play the video file');
    }

    const asset = await this.videoStreamRepository.getForMainPlaylist(assetId);
    if (!asset) {
      throw new NotFoundException('Asset metadata is not yet ready for streaming');
    }

    // Sharing the sessionId allows only one microservices worker to successfully insert to the session table.
    // The microservices worker that creates a session owns the transcoding lifecycle for it.
    const sessionId = this.cryptoRepository.randomUUID();
    const playlist = this.generateMainPlaylist(sessionId, ffmpeg, asset);
    await this.pendingSessions.wait(sessionId, () => {
      this.websocketRepository.serverSend('HlsSessionRequest', { sessionId, assetId, ownerId: auth.user.id });
    });
    this.trackSession(sessionId);

    return playlist;
  }

  private async isSealedOriginal(assetId: string) {
    const video = await this.assetRepository.getForVideo(assetId);
    return !!video && (await isLockedPath(video.originalPath));
  }

  async getMediaPlaylist(auth: AuthDto, assetId: string, sessionId: string, variantIndex: number, position?: number) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const asset = await this.videoStreamRepository.getForMediaPlaylist(assetId, sessionId);
    if (!asset) {
      throw new NotFoundException('Asset not found or metadata not yet ready for streaming');
    }

    const segmentation = this.getSegmentation(asset);
    const hintedSegment = position === undefined ? undefined : this.positionToSegmentIndex(segmentation, position);
    this.prewarmVariant(assetId, sessionId, variantIndex, hintedSegment);

    return this.generateMediaPlaylist(asset, segmentation);
  }

  async getSegment(
    auth: AuthDto,
    assetId: string,
    sessionId: string,
    variantIndex: number,
    filename: string,
    initSegment?: number,
  ) {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const session = await this.videoStreamRepository.getSession(sessionId);
    if (!session || session.assetId !== assetId) {
      throw new NotFoundException('Session not found');
    }

    const variantDir = StorageCore.getHlsVariantFolder({ ownerId: auth.user.id, sessionId, variantIndex });
    const path = join(variantDir, filename);
    const response = new FileDownloadResponse({
      path,
      contentType: 'video/mp4',
      cacheControl: CacheControl.PrivateWithCache,
    });

    const apiSession = this.trackSession(sessionId, variantIndex);
    const segmentIndex = this.getSegmentIndex(apiSession, filename, initSegment);
    this.websocketRepository.serverSend('HlsHeartbeat', { sessionId, variantIndex, segmentIndex });

    const result = { sessionId, variantIndex, segmentIndex };
    const key = this.getSegmentKey(result);
    await this.pendingSegments.wait(key, async (isPending) => {
      const exists = await this.storageRepository.checkFileExists(path, constants.R_OK);
      if (!isPending()) {
        return;
      }
      if (exists) {
        this.pendingSegments.complete(key, result);
      } else {
        this.websocketRepository.serverSend('HlsSegmentRequest', { ...result, assetId });
      }
    });

    return response;
  }

  async endSession(auth: AuthDto, assetId: string, sessionId: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [assetId] });

    const session = await this.videoStreamRepository.getSession(sessionId);
    if (!session) {
      return;
    }
    if (session.assetId !== assetId) {
      throw new NotFoundException('Session not found');
    }

    this.websocketRepository.serverSend('HlsSessionEnd', { sessionId });
  }

  private generateMainPlaylist(sessionId: string, ffmpeg: ConfigFFmpegDto, asset: AssetWithStreamInfo) {
    const fps = (asset.packets.packetCount * asset.videoStream.timeBase) / asset.packets.totalDuration;
    const roundedFps = fps.toFixed(3);
    const sourceResolution = Math.min(asset.videoStream.height, asset.videoStream.width);
    const targetResolution = Math.max(sourceResolution, HLS_VARIANTS[0].resolution);
    const lines = ['#EXTM3U', `#EXT-X-VERSION:${HLS_VERSION}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
    const { videoCodecs, resolutions } = ffmpeg.realtime;
    for (let i = 0; i < HLS_VARIANTS.length; i++) {
      const { resolution, bitrate, codec } = HLS_VARIANTS[i];
      if (resolution > targetResolution || !videoCodecs.includes(codec) || !resolutions.includes(resolution)) {
        continue;
      }
      const { width, height } = getOutputSize(asset.videoStream, resolution);
      const codecString = getCodecString(codec, width, height, fps);
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bitrate * 1.35)},RESOLUTION=${width}x${height},CODECS="${codecString},mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=${roundedFps}`,
        `${sessionId}/${i}/playlist.m3u8`,
      );
    }
    lines.push('');

    if (lines.length === 4) {
      throw new NotFoundException('No supported variants for this video');
    }

    return lines.join('\n');
  }

  private getSegmentation({ videoStream, packets }: AssetWithStreamInfo): Segmentation {
    const fps = (packets.packetCount * videoStream.timeBase) / packets.totalDuration;
    const framesPerSegment = Math.ceil(HLS_SEGMENT_DURATION * fps);
    const segmentCount = Math.ceil(packets.outputFrames / framesPerSegment);
    return { fps, framesPerSegment, segmentCount, segmentDuration: framesPerSegment / fps };
  }

  private positionToSegmentIndex({ segmentDuration, segmentCount }: Segmentation, position: number) {
    return Math.min(Math.max(Math.floor(position / segmentDuration), 0), segmentCount - 1);
  }

  private generateMediaPlaylist({ packets }: AssetWithStreamInfo, segmentation: Segmentation) {
    const { fps, framesPerSegment, segmentCount, segmentDuration: fullSegmentDuration } = segmentation;
    const lastSegmentFrames = packets.outputFrames - framesPerSegment * (segmentCount - 1);
    const lastSegmentDuration = lastSegmentFrames / fps;

    const lines = [
      '#EXTM3U',
      `#EXT-X-VERSION:${HLS_VERSION}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="init.mp4"',
    ];

    const fullSegment = `#EXTINF:${fullSegmentDuration.toFixed(6)},`;
    for (let i = 0; i < segmentCount - 1; i++) {
      lines.push(fullSegment, `seg_${i}.m4s`);
    }
    lines.push(`#EXTINF:${lastSegmentDuration.toFixed(6)},`, `seg_${segmentCount - 1}.m4s`, '#EXT-X-ENDLIST', '');

    return lines.join('\n');
  }

  private prewarmVariant(assetId: string, sessionId: string, variantIndex: number, hintedSegment?: number) {
    const session = this.sessions.get(sessionId);
    if (session?.lastVariantIndex === variantIndex) {
      return;
    }

    const nextSegment = session && session.lastRequestedSegment !== null ? session.lastRequestedSegment + 1 : undefined;
    const segmentIndex = hintedSegment ?? nextSegment;
    if (segmentIndex !== undefined) {
      this.websocketRepository.serverSend('HlsSegmentRequest', { sessionId, assetId, variantIndex, segmentIndex });
    }
  }

  private getSegmentKey({ sessionId, variantIndex, segmentIndex }: ArgOf<'HlsSegmentResult'>) {
    return `${sessionId}:${variantIndex}:${segmentIndex}`;
  }

  private getSegmentIndex(session: ApiSession, filename: string, initSegment?: number) {
    if (filename.endsWith('.mp4')) {
      // We need to know where to start transcoding, but the init.mp4 has no segment number in its name.
      // We can infer this from the last requested segment, but this can be inaccurate given the client
      // can load cached segments without reaching out to the server. `initSegment` acts as a hint to
      // remove ambiguity when possible.
      return initSegment ?? (session.lastRequestedSegment ?? -1) + 1;
    }
    const segmentIndex = Number.parseInt(HLS_SEGMENT_FILENAME_REGEX.exec(filename)![1]);
    session.lastRequestedSegment = segmentIndex;
    return segmentIndex;
  }

  private trackSession(id: string, variantIndex: number | null = null) {
    const session = this.sessions.get(id);
    if (!session) {
      const newSession = { lastRequestedSegment: null, lastVariantIndex: variantIndex };
      this.sessions.set(id, newSession);
      return newSession;
    }

    if (session.lastVariantIndex !== null && session.lastVariantIndex !== variantIndex) {
      this.pendingSegments.rejectByPrefix(`${id}:${session.lastVariantIndex}:`, 'Variant changed');
    }
    session.lastVariantIndex = variantIndex;
    return session;
  }
}
