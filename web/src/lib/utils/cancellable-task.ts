export class CancellableTask {
  cancelToken: AbortController | null = null;
  cancellable = true;
  complete!: Promise<unknown>;
  executed = false;

  private loadedSignal: (() => void) | undefined;
  private canceledSignal: (() => void) | undefined;

  constructor(
    private loadedCallback?: () => void,
    private canceledCallback?: () => void,
    private errorCallback?: (error: unknown) => void,
  ) {
    this.init();
  }

  get loading() {
    return Boolean(this.cancelToken);
  }

  async waitUntilCompletion() {
    if (this.executed) {
      return 'DONE';
    }
    try {
      await this.complete;
      return 'WAITED';
    } catch {
      return 'CANCELED';
    }
  }

  async waitUntilExecution() {
    while (!this.executed) {
      try {
        await this.complete;
        return 'WAITED';
      } catch {
        // Cancellation and errors publish a fresh completion for the next attempt.
      }
    }
    return 'DONE';
  }

  async execute<F extends (abortSignal: AbortSignal) => Promise<void>>(f: F, cancellable: boolean) {
    if (this.executed) {
      return 'DONE';
    }
    if (this.cancelToken) {
      this.cancellable &&= cancellable;
      try {
        await this.complete;
        return 'WAITED';
      } catch {
        return 'CANCELED';
      }
    }

    this.cancellable = cancellable;
    const token = (this.cancelToken = new AbortController());
    const completion = this.complete;
    let notifyingLoaded = false;
    try {
      try {
        await f(token.signal);
        if (this.complete !== completion) {
          return 'CANCELED';
        }
        if (!token.signal.aborted) {
          notifyingLoaded = true;
          this.#transitionToExecuted();
          return 'LOADED';
        }
      } catch (error) {
        if (this.complete !== completion) {
          return 'CANCELED';
        }
        if (!token.signal.aborted && (error as Error)?.name !== 'AbortError') {
          this.#transitionToErrored(error);
          return 'ERRORED';
        }
        if (notifyingLoaded) {
          return 'CANCELED';
        }
      }
      this.#transitionToCancelled();
      return 'CANCELED';
    } finally {
      if (this.cancelToken === token) {
        this.cancelToken = null;
      }
    }
  }

  private init() {
    this.cancelToken = null;
    this.executed = false;
    this.complete = new Promise<void>((resolve, reject) => {
      this.loadedSignal = resolve;
      this.canceledSignal = reject;
    });
    void this.complete.catch(() => {});
  }

  async reset() {
    const completion = this.complete;
    this.cancel();
    if (this.complete !== completion) {
      return;
    }
    if (this.cancelToken) {
      await this.waitUntilCompletion();
    }
    if (this.complete === completion) {
      this.init();
    }
  }

  cancel() {
    if (!this.executed && this.cancellable) {
      this.#transitionToCancelled();
    }
  }

  #transitionToCancelled() {
    const token = this.cancelToken;
    const reject = this.canceledSignal;
    this.init();
    reject?.();
    token?.abort();
    this.canceledCallback?.();
  }

  #transitionToExecuted() {
    this.executed = true;
    this.loadedSignal?.();
    this.loadedCallback?.();
  }

  #transitionToErrored(error: unknown) {
    const reject = this.canceledSignal;
    this.init();
    reject?.();
    this.errorCallback?.(error);
  }
}
