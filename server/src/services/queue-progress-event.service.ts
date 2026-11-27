import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { onJobSettled } from 'src/queue/settled.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';

/** At most one nudge in this long: a busy queue starts and finishes many jobs a second. */
export const QUEUE_PROGRESS_INTERVAL_MS = 1000;
/** How long the list of administrators is kept; a new or demoted administrator is picked up after this. */
const ADMINS_TTL_MS = 60_000;

/**
 * Tells administrators' open pages that the server's job queues moved (FL-1794, `on_queue_progress`).
 *
 * The top bar used to ask for the running-jobs summary every few seconds to find this out. The event
 * carries nothing: a page answers it by asking the summary again, which checks the caller's access as
 * any other request does. It goes to administrators' own sockets only, at most once a second from each
 * process that runs jobs, with one more after the last change so the final state is never missed. A job
 * that fails or is deferred settles like one that succeeds. Pausing or emptying a queue sends nothing:
 * the page that did it reads the summary itself, and other administrators' pages see it at their next look.
 */
@Injectable()
export class QueueProgressEventService {
  private lastSent = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private admins?: { at: number; ids: Promise<string[]> };
  private unsubscribe?: () => void;

  constructor(
    private userRepository: UserRepository,
    private websocket: WebsocketRepository,
  ) {}

  @OnEvent({ name: 'JobStart' })
  onJobStart() {
    this.nudge();
  }

  /** Every outcome, not only a committed success (`JobComplete`): a failed last job must end the run too. */
  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    this.unsubscribe ??= onJobSettled(() => this.nudge());
  }

  onJobSettled() {
    this.nudge();
  }

  @OnEvent({ name: 'QueueStart' })
  onQueueStart() {
    this.nudge();
  }

  @OnEvent({ name: 'QueueResumed' })
  onQueueResumed() {
    this.nudge();
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Runs for every job, so it does nothing but compare a time unless a nudge is due. */
  nudge() {
    if (this.timer) {
      return;
    }
    const wait = this.lastSent + QUEUE_PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      void this.send();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.send();
    }, wait);
    this.timer.unref?.();
  }

  private async send() {
    this.lastSent = Date.now();
    try {
      for (const id of await this.adminIds()) {
        this.websocket.clientSend('on_queue_progress', id);
      }
    } catch {
      // The pages still have their slow poll; the next change tries again.
      this.admins = undefined;
    }
  }

  private adminIds() {
    if (!this.admins || Date.now() - this.admins.at > ADMINS_TTL_MS) {
      this.admins = {
        at: Date.now(),
        ids: this.userRepository.getAdmins().then((admins) => admins.map(({ id }) => id)),
      };
    }
    return this.admins.ids;
  }
}
