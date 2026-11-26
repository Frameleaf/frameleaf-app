import { getContext, setContext, type Snippet } from 'svelte';

/** What a page asks of the shell around it; read live, so a page can change its mind. */
export interface ShellPage {
  readonly hideNavbar: boolean;
  /** Show the library rail (Studio has none). */
  readonly rail: boolean;
  readonly onUploadClick: () => void;
  /** Extra content inside the library rail, below the navigation. */
  readonly railExtra?: Snippet;
}

/**
 * FL-1796: the pages that are drawing inside the shell right now. The newest decides what the shell
 * shows; with none, the shell draws nothing around the page (the viewer, a page with its own frame).
 * During a page change the old page leaves and the new one arrives in the same update, so the top
 * bar and the rail stay mounted.
 */
export class UserShellPages {
  // The list is plain and a counter announces its changes: a page leaves in a teardown, where Svelte
  // answers a state read with the value from before the update, so a list kept in state would be
  // filtered from a stale copy and lose the page that had just arrived.
  #pages: ShellPage[] = [];
  #changes = 0;
  #changed = $state(0);

  get current(): ShellPage | undefined {
    void this.#changed;
    return this.#pages.at(-1);
  }

  /** Returns the function that takes the page out again. */
  add(page: ShellPage) {
    this.#pages.push(page);
    this.#changed = ++this.#changes;
    return () => {
      this.#pages = this.#pages.filter((item) => item !== page);
      this.#changed = ++this.#changes;
    };
  }
}

const KEY = Symbol('user-shell');

export const provideUserShell = () => setContext(KEY, new UserShellPages());
export const useUserShell = () => getContext<UserShellPages | undefined>(KEY);
