/**
 * The mail account this server sends from, as Email delivery shows it (FL-379): what the server
 * says is connected, and the sign-in an administrator has in progress.
 *
 * A sign-in opens the provider's own page in a new tab. That page returns to Frameleaf Cloud, not to
 * this server (a server at home has no public address), so this page asks the server every few
 * seconds whether it has finished; the server collects the answer from Frameleaf Cloud. Nothing here
 * ever holds a token: the server keeps it and returns only the connected address.
 */
import {
  completeMailSignIn,
  disconnectMailAccount,
  getMailConnection,
  MailSignInState,
  startMailSignIn,
  type MailConnectionDto,
  type MailConnectionStateDto,
  type MailDisconnectResponseDto,
  type MailSignInProvider,
} from '@frameleaf/sdk';
import { getServerErrorMessage } from '$lib/utils/handle-error';

/** How often the server is asked whether the sign-in has finished. */
export const SIGN_IN_POLL_MS = 2500;

export type SignInOutcome =
  | { kind: 'denied' | 'expired' }
  /** Starting or finishing failed; `reason` is the server's own, when it gave one. */
  | { kind: 'failed'; reason?: string };

export class MailSignInStore {
  /** What the server says; null until the first answer. */
  state = $state<MailConnectionStateDto | null>(null);
  /** The first answer could not be loaded. */
  loadFailed = $state(false);
  /** The provider whose sign-in page is open and being waited for. */
  waiting = $state<MailSignInProvider | null>(null);
  /** How the last sign-in ended when it did not connect; cleared by the next one. */
  outcome = $state<SignInOutcome | null>(null);
  /** A start or a disconnect is on its way to the server. */
  busy = $state(false);

  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #onConnected: (connection: MailConnectionDto) => void | Promise<void>;

  constructor(onConnected: (connection: MailConnectionDto) => void | Promise<void>) {
    this.#onConnected = onConnected;
  }

  get connection() {
    return this.state?.connection ?? null;
  }

  /** Reads the connection; a sign-in started before the page was reloaded is picked up again. */
  async load() {
    try {
      this.state = await getMailConnection();
      this.loadFailed = false;
      if (this.state.signIn === MailSignInState.Pending && this.state.signInProvider && !this.waiting) {
        this.waiting = this.state.signInProvider;
        this.#schedule();
      }
    } catch {
      this.loadFailed = true;
    }
  }

  /**
   * Opens the provider's sign-in page in a new tab and waits for it. The tab is opened before the
   * server is asked, while the click still counts as the person's own, or the browser blocks it.
   */
  async signIn(provider: MailSignInProvider) {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.outcome = null;
    this.#clear();
    const tab = window.open('', '_blank');
    try {
      const { authorizationUrl } = await startMailSignIn({ mailSignInStartDto: { provider } });
      if (tab) {
        // the provider's page gets no handle on this one
        tab.opener = null;
        tab.location.href = authorizationUrl;
      } else {
        // the browser blocked the new tab: the same page, in this one
        location.assign(authorizationUrl);
      }
      this.waiting = provider;
      this.#schedule();
    } catch (error) {
      tab?.close();
      this.waiting = null;
      this.outcome = { kind: 'failed', reason: getServerErrorMessage(error) };
    } finally {
      this.busy = false;
    }
  }

  /** Stops waiting for the open sign-in page; the sign-in itself simply runs out. */
  cancel() {
    this.#clear();
    this.waiting = null;
  }

  /** Disconnects the account; resolves with the server's answer, or undefined when it failed. */
  async disconnect(): Promise<MailDisconnectResponseDto | undefined> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.outcome = null;
    try {
      const result = await disconnectMailAccount();
      await this.load();
      return result;
    } catch (error) {
      this.outcome = { kind: 'failed', reason: getServerErrorMessage(error) };
    } finally {
      this.busy = false;
    }
  }

  /** Stops asking; call when the page goes away. */
  stop() {
    this.#stopped = true;
    this.#clear();
  }

  #clear() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule() {
    this.#clear();
    if (!this.#stopped) {
      this.#timer = setTimeout(() => void this.#check(), SIGN_IN_POLL_MS);
    }
  }

  async #check() {
    let answer;
    try {
      answer = await completeMailSignIn();
    } catch (error) {
      this.waiting = null;
      this.outcome = { kind: 'failed', reason: getServerErrorMessage(error) };
      await this.load();
      return;
    }
    if (this.#stopped || !this.waiting) {
      return;
    }
    switch (answer.state) {
      case MailSignInState.Pending: {
        this.#schedule();
        return;
      }
      case MailSignInState.Connected: {
        this.waiting = null;
        await this.load();
        if (answer.connection) {
          await this.#onConnected(answer.connection);
        }
        return;
      }
      case MailSignInState.Denied: {
        this.waiting = null;
        this.outcome = { kind: 'denied' };
        return;
      }
      default: {
        // expired, or nothing is waiting any more: either way, start again
        this.waiting = null;
        this.outcome = { kind: 'expired' };
      }
    }
  }
}
