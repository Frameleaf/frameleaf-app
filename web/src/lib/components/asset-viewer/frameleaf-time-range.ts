import { MediaUIEvents } from 'media-chrome/constants';
import MediaTimeRange from 'media-chrome/media-time-range';

const COMMIT_DELAY_MS = 750;

/** Custom MediaTimeRange that only seeks after pointer release to avoid hammering the server.
 * Keyboard input uses timed debouncing instead since there's no release event.
 * With `live` (FL-650: a file played directly, where a seek is just a byte-range read) it seeks as you drag. */
class FrameleafTimeRange extends MediaTimeRange {
  private seeking = false;
  private pending: number | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pointerId: number | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointerdown', this.hold);
    this.addEventListener('keydown', this.hold);
    this.addEventListener('pointerup', this.release);
    this.addEventListener('pointercancel', this.release);
    this.addEventListener(MediaUIEvents.MEDIA_SEEK_REQUEST, this.intercept, { capture: true });
  }

  override disconnectedCallback() {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.seeking = false;
    this.pending = undefined;
    this.pointerId = undefined;
    this.removeEventListener('pointerdown', this.hold);
    this.removeEventListener('keydown', this.hold);
    this.removeEventListener('pointerup', this.release);
    this.removeEventListener('pointercancel', this.release);
    this.removeEventListener(MediaUIEvents.MEDIA_SEEK_REQUEST, this.intercept, true);
    this.removePointerListeners();
    super.disconnectedCallback();
  }

  private removePointerListeners() {
    this.ownerDocument.defaultView?.removeEventListener('pointerup', this.release);
    this.ownerDocument.defaultView?.removeEventListener('pointercancel', this.release);
  }

  private hold = (event: Event) => {
    if (this.hasAttribute('live')) {
      return;
    }
    if (event instanceof KeyboardEvent && !this.keysUsed.includes(event.key)) {
      return;
    }
    if (event instanceof PointerEvent && this.pointerId !== undefined && event.pointerId !== this.pointerId) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.removePointerListeners();
    if (event instanceof KeyboardEvent) {
      this.pointerId = undefined;
      this.idleTimer = setTimeout(this.release, COMMIT_DELAY_MS);
    } else {
      this.pointerId = (event as PointerEvent).pointerId;
      this.idleTimer = undefined;
      this.ownerDocument.defaultView?.addEventListener('pointerup', this.release);
      this.ownerDocument.defaultView?.addEventListener('pointercancel', this.release);
    }
    this.seeking = true;
  };

  private intercept = (event: Event) => {
    if (!this.seeking) {
      return; // not mid-scrub, or this is the request we replay in release()
    }
    this.pending = (event as CustomEvent<number>).detail;
    event.stopImmediatePropagation();
  };

  private release = (event?: Event) => {
    if (this.pointerId !== undefined && event && (event as PointerEvent).pointerId !== this.pointerId) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.removePointerListeners();
    this.seeking = false;
    this.pointerId = undefined;
    if (this.pending !== undefined) {
      const detail = this.pending;
      this.pending = undefined;
      this.dispatchEvent(new CustomEvent(MediaUIEvents.MEDIA_SEEK_REQUEST, { bubbles: true, composed: true, detail }));
    }
  };
}

if (!customElements.get('frameleaf-time-range')) {
  customElements.define('frameleaf-time-range', FrameleafTimeRange);
}
