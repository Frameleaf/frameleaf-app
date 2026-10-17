import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

type CronBase = {
  name: string;
  start?: boolean;
};

export type CronCreate = CronBase & {
  expression: string;
  onTick: () => void;
};

export type CronUpdate = CronBase & {
  expression?: string;
};

@Injectable()
export class CronRepository {
  /**
   * FL-426: the zone every schedule runs in, the one chosen in Server name & welcome
   * (`server.timeZone`); unset is the computer's own clock, as before.
   */
  private timeZone?: string;
  /** The schedules made here, which follow a new time zone. */
  private readonly names = new Set<string>();

  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(CronRepository.name);
  }

  create({ name, expression, onTick, start = true }: CronCreate): void {
    const job = CronJob.from<null, null>({
      cronTime: expression,
      onTick,
      start,
      unrefTimeout: true,
      timeZone: this.timeZone,
    });

    try {
      this.schedulerRegistry.addCronJob(name, job);
      this.names.add(name);
    } catch (error) {
      void job.stop();
      throw error;
    }
  }

  update({ name, expression, start }: CronUpdate): void {
    const job = this.schedulerRegistry.getCronJob(name);
    if (expression) {
      job.setTime(new CronTime(expression, this.timeZone));
    }
    if (start !== undefined) {
      if (start) {
        job.start();
      } else {
        void job.stop();
      }
    }
  }

  /**
   * FL-426: run every schedule made here in `zone` from now on, each keeping its own expression and
   * whether it is running. An empty zone is the computer's own clock.
   */
  setTimeZone(zone: string): void {
    const next = zone || undefined;
    if (next === this.timeZone) {
      return;
    }
    this.timeZone = next;
    for (const name of this.names) {
      if (!this.schedulerRegistry.doesExist('cron', name)) {
        continue;
      }
      const job = this.schedulerRegistry.getCronJob(name);
      const { source } = job.cronTime;
      if (typeof source === 'string') {
        job.setTime(new CronTime(source, next));
      }
    }
    this.logger.log(`Schedules follow ${next ?? "the computer's own time zone"}`);
  }
}
