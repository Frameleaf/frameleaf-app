import { getAboutInfo } from '@immich/sdk';

/**
 * FL-135: documentation links go to this installation's own documentation (`FRAMELEAF_DOCS_URL`,
 * validated by the server and reported as `thirdPartyDocumentationUrl`), never to another
 * project's site. Without one configured a docs link is simply not shown.
 */
export const docsLink = (base: string, path: string) => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

class HelpLinks {
  #documentationUrl = $state<string | undefined>();
  #requested = false;

  #load() {
    if (this.#requested) {
      return;
    }
    this.#requested = true;
    getAboutInfo()
      .then((about) => (this.#documentationUrl = about.thirdPartyDocumentationUrl || undefined))
      .catch(() => (this.#requested = false));
  }

  /** The address of a page of this installation's documentation, or undefined when none is configured. */
  docs(path: string) {
    this.#load();
    return this.#documentationUrl ? docsLink(this.#documentationUrl, path) : undefined;
  }
}

export const helpLinks = new HelpLinks();
