import { statfs } from 'node:fs/promises';
import { Refusal } from './contracts.js';

/**
 * FL-1317 Check this server: every check Manager can make before it downloads anything, reported together.
 *
 * - ok: nothing to say beyond `facts`.
 * - problem: blocks the install. `code` is the refusal the install would otherwise stop with.
 * - warning: worth knowing, never blocks (FL-1318 adds memory and similar findings).
 * - unknown: Manager couldn't tell; never blocks. The install's own step is the final authority.
 *
 * The UI words every result from `id`, `code` and `facts` (manager/ui/src/server-check.ts), with fix steps for
 * each host. To add a check: give it an id below, run it with `checks.run(id, ...)` in the review, add the guard at
 * install start if it can change after the review, and add its label and wording in the UI module.
 */
export type CheckStatus = 'ok' | 'problem' | 'warning' | 'unknown';
export type CheckId = 'docker' | 'media' | 'database' | 'backups' | 'manager' | 'containers' | 'port' | 'release' | (string & {});
export type CheckFacts = Record<string, string | number | boolean | null>;
export type CheckResult = { id: CheckId; status: CheckStatus; code?: string; detail?: string; facts?: CheckFacts };
/** What a check's work returns: its facts, and optionally a non-blocking finding instead of ok. */
export type CheckOutcome = { facts?: CheckFacts; status?: 'ok' | 'warning' | 'unknown'; code?: string; detail?: string };
/** The host whose fix steps the UI shows. HexOS sets MANAGER_PLATFORM=hexos; a plain Docker host is linux. */
export type CheckHost = 'unraid' | 'truenas' | 'hexos' | 'linux';
export const checkHost = (platform = process.env.MANAGER_PLATFORM): CheckHost =>
  platform === 'unraid' || platform === 'truenas' || platform === 'hexos' ? platform : 'linux';

export class ServerCheck {
  readonly results: CheckResult[] = [];
  /**
   * Runs one check and records its result. A refusal is a problem; any other error is a problem too unless the
   * check says Manager merely couldn't tell (`unknownOnError`). Returns the work's value, or undefined when it failed.
   */
  async run<T>(
    id: CheckId,
    work: () => Promise<{ value?: T; outcome?: CheckOutcome } | void>,
    options: { unknownOnError?: boolean } = {},
  ): Promise<T | undefined> {
    try {
      const { value, outcome } = (await work()) ?? {};
      this.results.push({ id, status: outcome?.status ?? 'ok', ...pick(outcome) });
      return value;
    } catch (error) {
      const refusal = error instanceof Refusal ? error : null;
      this.results.push({
        id,
        status: !refusal && options.unknownOnError ? 'unknown' : 'problem',
        code: refusal?.code ?? 'check_failed',
        ...(refusal?.detail && { detail: refusal.detail }),
      });
      return undefined;
    }
  }
  /** Adds facts to a check that already ran (the port check learns the next free port separately). */
  annotate(id: CheckId, facts: CheckFacts): void {
    const result = this.results.find((item) => item.id === id);
    if (result) result.facts = { ...result.facts, ...facts };
  }
  get blocked(): boolean {
    return this.results.some((result) => result.status === 'problem');
  }
  /** At install start the same checks are a guard: the first problem refuses, as the review used to. */
  assert(): void {
    const problem = this.results.find((result) => result.status === 'problem');
    if (problem) throw new Refusal(problem.code ?? 'check_failed', 409, problem.detail);
  }
}

const pick = (outcome?: CheckOutcome) => ({
  ...(outcome?.code && { code: outcome.code }),
  ...(outcome?.detail && { detail: outcome.detail }),
  ...(outcome?.facts && { facts: outcome.facts }),
});

/** Free bytes where `path` lives, for the "Can save here · 2.1 TB free" line. Null when the folder can't be read. */
export const freeBytes = async (path: string): Promise<number | null> =>
  statfs(path).then((space) => space.bavail * space.bsize, () => null);
