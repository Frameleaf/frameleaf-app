/**
 * FL-360: the write fence the Frameleaf Manager library move raises in the API process.
 *
 * While it is up, requests that can change the library (any method other than GET, HEAD and
 * OPTIONS) are refused with 503, except signing in and out, sync and search (database reads and
 * receipts, never media) and the move's own pause endpoints. Write requests already admitted are
 * counted until their response closes and their handler settles, so the move only proceeds once
 * none are in flight.
 *
 * The check and the count happen in the same synchronous step, so no request can slip past a fence
 * raised between them.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_WHILE_FENCED = /^(?:\/api)?\/(?:auth|sync|search|server\/library-move|admin\/library-move)(?:\/|$)/;

export const LIBRARY_MOVE_RETRY_AFTER_SECONDS = 60;

class LibraryMoveFence {
  private raised = false;
  private inFlight = 0;

  get active() {
    return this.raised;
  }

  get writesInFlight() {
    return this.inFlight;
  }

  raise() {
    this.raised = true;
  }

  lower() {
    this.raised = false;
  }

  /** Whether a request with this method and path is subject to the fence at all. */
  isWrite(method: string, path: string) {
    return !SAFE_METHODS.has(method.toUpperCase()) && !ALLOWED_WHILE_FENCED.test(path);
  }

  /**
   * Admit a request: returns `false` when the fence refuses it, otherwise a release function to
   * call once its response has closed (a no-op for requests the fence does not count).
   */
  admit(method: string, path: string): false | (() => void) {
    if (!this.isWrite(method, path)) {
      return () => {};
    }
    if (this.raised) {
      return false;
    }
    this.inFlight++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight--;
    };
  }
}

export const libraryMoveFence = new LibraryMoveFence();
