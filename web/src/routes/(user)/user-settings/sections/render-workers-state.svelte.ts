/**
 * What Computers › Advanced knows about Studio helpers (FL-95): the enrolled helpers, the limits for
 * each person and the history. One instance is shared by the page's parts (Each computer's details,
 * Limits for each person, History), so a change made in one part shows in the others at once.
 */
import {
  getRenderWorkerLimits,
  listRenderWorkers,
  searchRenderWorkerAudit,
  type RenderWorkerAuditDto,
  type RenderWorkerDto,
  type RenderWorkerLimitsResponseDto,
} from '@frameleaf/sdk';
import { handleError } from '$lib/utils/handle-error';
import type { RenderWorkersData } from './loaders';

export class RenderWorkersState {
  workers = $state<RenderWorkerDto[]>([]);
  limits = $state<RenderWorkerLimitsResponseDto>() as RenderWorkerLimitsResponseDto;
  audit = $state<RenderWorkerAuditDto[]>([]);
  auditWorkerId = $state<string | undefined>();
  refreshing = $state(false);
  now = $state(new Date());

  /** The 30 s poll reports an outage once, not on every failed check, and again only after a recovery. */
  #workersFailing = false;

  constructor(
    data: RenderWorkersData,
    private readonly failed: () => string,
  ) {
    this.workers = data.workers;
    this.limits = data.limits;
    this.audit = data.audit;
  }

  /** Health is derived from `lastSeenAt` against the clock, so the clock ticks with each poll. */
  poll = () => {
    const timer = setInterval(() => {
      this.now = new Date();
      void this.refreshWorkers();
    }, 30_000);
    return () => clearInterval(timer);
  };

  refreshWorkers = async () => {
    try {
      this.workers = await listRenderWorkers();
      this.#workersFailing = false;
    } catch (error) {
      if (!this.#workersFailing) {
        this.#workersFailing = true;
        handleError(error, this.failed());
      }
    }
  };

  refreshLimits = async () => {
    try {
      this.limits = await getRenderWorkerLimits();
    } catch (error) {
      handleError(error, this.failed());
    }
  };

  refreshAudit = async (workerId: string | undefined = this.auditWorkerId) => {
    this.auditWorkerId = workerId;
    this.refreshing = true;
    try {
      this.audit = await searchRenderWorkerAudit({ take: 100, workerId });
    } catch (error) {
      handleError(error, this.failed());
    } finally {
      this.refreshing = false;
    }
  };
}
