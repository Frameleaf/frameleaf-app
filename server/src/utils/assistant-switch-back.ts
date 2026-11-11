import { randomUUID } from 'node:crypto';
import { Counter, type Registry } from 'prom-client';

export const SWITCH_BACK_WINDOW_MS = 30_000;
export const SWITCH_BACK_LIMIT = 4096;

/** Only aggregate counts are exported. A pending answer keeps its issuing session in memory for at most 30 seconds. */
export class AssistantSwitchBack {
  private readonly searches = new Counter({
    name: 'frameleaf_assistant_searches_total',
    help: 'Library Assistant answers returned to signed-in sessions',
    registers: [],
  });
  private readonly switchBacks = new Counter({
    name: 'frameleaf_assistant_switch_backs_total',
    help: 'Explicit switches to Classic search within 30 seconds of an Assistant answer',
    registers: [],
  });
  private readonly pending = new Map<string, { sessionId: string; expiresAt: number; timer: NodeJS.Timeout }>();

  register(registry: Registry) {
    registry.registerMetric(this.searches);
    registry.registerMetric(this.switchBacks);
  }

  answer(sessionId: string | undefined) {
    if (!sessionId) {
      return;
    }
    this.searches.inc();
    if (this.pending.size >= SWITCH_BACK_LIMIT) {
      // shortcut: discard the oldest pending token during a burst, increase the bound if measured traffic needs it
      const oldest = this.pending.keys().next().value;
      if (oldest) {
        this.remove(oldest);
      }
    }
    const token = randomUUID();
    const expiresAt = performance.now() + SWITCH_BACK_WINDOW_MS;
    const timer = setTimeout(() => this.pending.delete(token), SWITCH_BACK_WINDOW_MS).unref();
    this.pending.set(token, { sessionId, expiresAt, timer });
    return token;
  }

  switchBack(sessionId: string | undefined, token: string) {
    const answer = this.pending.get(token);
    if (!answer || answer.sessionId !== sessionId || performance.now() >= answer.expiresAt) {
      return;
    }
    this.remove(token);
    this.switchBacks.inc();
  }

  private remove(token: string) {
    clearTimeout(this.pending.get(token)?.timer);
    this.pending.delete(token);
  }
}

export const assistantSwitchBack = new AssistantSwitchBack();
