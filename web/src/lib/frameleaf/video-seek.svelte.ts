/**
 * A request to start a video at a moment (FL-59). The moments panel and moment search ask; the
 * video viewer answers once the video's metadata has loaded, then forgets the request, so a later
 * visit to the same video starts from the beginning as usual.
 */
type SeekRequest = { assetId: string; seconds: number };

class VideoSeek {
  pending = $state<SeekRequest | null>(null);

  request(assetId: string, timestampMs: number) {
    this.pending = { assetId, seconds: Math.max(0, timestampMs) / 1000 };
  }

  /** The seconds to seek to for this video, consuming the request; null when there is none. */
  take(assetId: string): number | null {
    const request = this.pending;
    if (!request || request.assetId !== assetId) {
      return null;
    }
    this.pending = null;
    return request.seconds;
  }
}

export const videoSeek = new VideoSeek();
