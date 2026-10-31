const noop = () => {};
export class LoggingRepository {
  static create() {
    return {
      log: noop,
      warn: noop,
      error: noop,
      debug: noop,
      verbose: noop,
      setContext: noop,
    };
  }
}
