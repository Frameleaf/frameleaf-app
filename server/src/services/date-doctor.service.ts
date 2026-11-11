import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DateDoctorFindingsResponseDto, DateDoctorGroup } from 'src/dtos/date-doctor.dto.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { DateDoctorRepository } from 'src/repositories/date-doctor.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { JobOf } from 'src/types.js';
import { detectDateFindings } from 'src/utils/date-doctor.js';

/**
 * FL-912: the Date & Time Doctor finds photos whose date or time zone is probably wrong and proposes a fix with a
 * reason (`src/utils/date-doctor.ts`). It changes nothing: applying a proposal, with XMP and undo, is FL-930.
 *
 * A scan runs per owner, when asked (`POST /date-doctor/scan`) and once a week in the overnight "Check files" step,
 * on the file checks' queue, so that step waits for it.
 */
@Injectable()
export class DateDoctorService {
  constructor(
    private logger: LoggingRepository,
    private jobRepository: JobRepository,
    private dateDoctorRepository: DateDoctorRepository,
  ) {
    this.logger.setContext(DateDoctorService.name);
  }

  async scan(auth: AuthDto): Promise<void> {
    await this.jobRepository.queue({ name: JobName.DateDoctorScan, data: { userId: auth.user.id } });
  }

  async getFindings(auth: AuthDto): Promise<DateDoctorFindingsResponseDto> {
    const rows = await this.dateDoctorRepository.getFindings(auth.user.id);
    const groups = new Map<string, DateDoctorGroup>();
    for (const row of rows) {
      let group = groups.get(row.groupKey);
      if (!group) {
        const [camera, day] = row.groupKey.split('|');
        group = { groupKey: row.groupKey, camera: camera === 'unknown' ? null : camera, day, findings: [] };
        groups.set(row.groupKey, group);
      }
      group.findings.push({
        assetId: row.assetId,
        cause: row.cause,
        currentDate: new Date(row.currentDate).toISOString(),
        currentZone: row.currentZone,
        proposedDate: row.proposedDate ? new Date(row.proposedDate).toISOString() : null,
        proposedZone: row.proposedZone,
        confidence: row.confidence,
      });
    }
    return { total: rows.length, groups: [...groups.values()] };
  }

  @OnJob({ name: JobName.DateDoctorScanQueueAll, queue: QueueName.IntegrityCheck })
  async handleQueueAll(): Promise<JobStatus> {
    const userIds = await this.dateDoctorRepository.getOwnerIds();
    await this.jobRepository.queueAll(
      userIds.map((userId) => ({ name: JobName.DateDoctorScan as const, data: { userId } })),
    );
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.DateDoctorScan, queue: QueueName.IntegrityCheck })
  async handleScan({ userId }: JobOf<JobName.DateDoctorScan>): Promise<JobStatus> {
    const started = Date.now();
    const rows = await this.dateDoctorRepository.getScanRows(userId);
    const findings = detectDateFindings(rows);
    await this.dateDoctorRepository.replaceFindings(userId, findings);
    this.logger.log(
      `Date & Time Doctor: ${findings.length} findings in ${rows.length} photos of ${userId} (${Date.now() - started} ms)`,
    );
    return JobStatus.Success;
  }
}
