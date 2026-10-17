/**
 * @license Apache-2.0
 * https://github.com/hperrin/svelte-material-ui/blob/master/packages/common/src/internal/useActions.ts
 */

export type SvelteActionReturnType<P> = void | {
  update?: (newParams?: P) => void;
  destroy?: () => void;
};

export type SvelteHTMLActionType<P> = (node: HTMLElement, params?: P) => SvelteActionReturnType<P>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HTMLActionEntry<P = any> = SvelteHTMLActionType<P> | [SvelteHTMLActionType<P>, P];

export type HTMLActionArray = HTMLActionEntry[];

export type SvelteSVGActionType<P> = (node: SVGElement, params?: P) => SvelteActionReturnType<P>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SVGActionEntry<P = any> = SvelteSVGActionType<P> | [SvelteSVGActionType<P>, P];

export type SVGActionArray = SVGActionEntry[];

export type ActionArray = HTMLActionArray | SVGActionArray;

export function useActions(node: HTMLElement | SVGElement, actions: ActionArray) {
  const handlers: SvelteActionReturnType<unknown>[] = [];
  let stopped = false;
  let cleaning = false;

  const release = () => {
    if (cleaning) {
      return;
    }
    stopped = true;
    cleaning = true;
    const failures: unknown[] = [];
    try {
      for (let index = 0; index < handlers.length; index++) {
        const handler = handlers[index];
        handlers[index] = undefined;
        try {
          handler?.destroy?.();
        } catch (error) {
          handlers[index] = handler;
          failures.push(error);
        }
      }
    } finally {
      cleaning = false;
    }
    if (failures.length > 0) {
      throw failures[0];
    }
    handlers.length = 0;
  };

  try {
    for (const entry of actions ?? []) {
      const action = Array.isArray(entry) ? entry[0] : entry;
      handlers.push(
        Array.isArray(entry) && entry.length > 1
          ? action(node as HTMLElement & SVGElement, entry[1])
          : action(node as HTMLElement & SVGElement),
      );
    }
  } catch (error) {
    const failures = [error];
    try {
      release();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Action setup failed and cleanup did not finish.', { cause: error });
    }
    throw error;
  }

  return {
    update(nextActions: ActionArray) {
      if (stopped) {
        return;
      }
      if ((nextActions?.length ?? 0) !== handlers.length) {
        throw new Error('You must not change the length of an actions array.');
      }
      for (let index = 0; index < handlers.length && !stopped; index++) {
        const handler = handlers[index];
        if (!handler?.update) {
          continue;
        }
        const entry = nextActions[index];
        if (Array.isArray(entry) && entry.length > 1) {
          handler.update(entry[1]);
        } else {
          handler.update();
        }
      }
    },
    destroy() {
      release();
    },
  };
}
