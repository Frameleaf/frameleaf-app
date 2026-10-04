import * as Oazapfts from '@oazapfts/runtime';
import { defaults } from './fetch-client.js';

/** Durable queue run API. Kept outside generated code until hosted OpenAPI regeneration. */
export type DurableJobRun = {
  id: string;
  kind: string;
  createdAt: string;
  finishedAt: string | null;
  enumerationDone: boolean;
  total: number;
  completed: number;
  failed: number;
  active: number;
  waiting: number;
  state: 'running' | 'blocked' | 'unavailable' | 'completed' | 'failed' | 'needs_attention';
};

const client = Oazapfts.runtime(defaults);
export const listDurableJobRuns = (
  { take = 25, skip = 0 }: { take?: number; skip?: number } = {},
  opts?: Oazapfts.RequestOpts,
) =>
  client.ok(
    client.fetchJson<{ status: 200; data: DurableJobRun[] }>(`/jobs/runs?take=${take}&skip=${skip}`, { ...opts }),
  );
