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
  constructor(
    private schedulerRegistry: SchedulerRegistry,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(CronRepository.name);
  }

  create({ name, expression, onTick, start = true }: CronCreate): void {
    const job = CronJob.from<null, null>({ cronTime: expression, onTick, start, unrefTimeout: true });

    try {
      this.schedulerRegistry.addCronJob(name, job);
    } catch (error) {
      void job.stop();
      throw error;
    }
  }

  update({ name, expression, start }: CronUpdate): void {
    const job = this.schedulerRegistry.getCronJob(name);
    if (expression) {
      job.setTime(new CronTime(expression));
    }
    if (start !== undefined) {
      if (start) {
        job.start();
      } else {
        void job.stop();
      }
    }
  }
}
