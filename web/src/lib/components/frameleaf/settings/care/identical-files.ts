import type { IdenticalFilesProblemDto, IdenticalFilesStatusDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * FL-416: the files the identical-files check skipped, as Duplicates lists them (owner, 2026-10-23: the
 * three kinds as prototyped). Files in folders Frameleaf never changes (external libraries) are the third
 * kind; they come from the libraries, not from the check's report. Every other kind the check records
 * stays out of this list: look-alikes to check before merging are in Duplicate review, and the rest are
 * the run's own bookkeeping.
 */
export type IdenticalProblemKind = 'unreadable' | 'changed';

export type IdenticalProblem = {
  kind: IdenticalProblemKind;
  count: number;
  /** The file's name when there is one file of this kind and the check named its path. */
  name?: string;
};

/** The check's kinds, read as the two kinds a person can tell apart. */
const KIND_OF: Partial<Record<IdenticalFilesProblemDto['kind'], IdenticalProblemKind>> = {
  missing: 'unreadable',
  unreadable: 'unreadable',
  damaged: 'unreadable',
  changed: 'changed',
};

export const PROBLEM_COPY: Record<
  IdenticalProblemKind,
  { count: Translations; status: Translations; note: Translations }
> = {
  unreadable: {
    count: 'frameleaf_dupes_problem_unreadable_count',
    status: 'frameleaf_dupes_problem_unreadable',
    note: 'frameleaf_dupes_problem_unreadable_note',
  },
  changed: {
    count: 'frameleaf_dupes_problem_changed_count',
    status: 'frameleaf_dupes_problem_changed',
    note: 'frameleaf_dupes_problem_changed_note',
  },
};

const fileName = (path: string | null) => (path ? path.split(/[\\/]/).pop() || undefined : undefined);

export const identicalProblems = (problems: IdenticalFilesStatusDto['problems']): IdenticalProblem[] => {
  const byKind = new Map<IdenticalProblemKind, IdenticalFilesProblemDto[]>();
  for (const problem of problems) {
    const kind = KIND_OF[problem.kind];
    if (kind) {
      byKind.set(kind, [...(byKind.get(kind) ?? []), problem]);
    }
  }
  return (['unreadable', 'changed'] as const).flatMap((kind) => {
    const found = byKind.get(kind) ?? [];
    if (found.length === 0) {
      return [];
    }
    const name = found.length === 1 ? fileName(found[0].path) : undefined;
    return [{ kind, count: found.length, ...(name && { name }) }];
  });
};
