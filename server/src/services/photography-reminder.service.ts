import { Injectable } from '@nestjs/common';
import type { PhotographyWorkflow } from 'src/services/photography-workflow.service.js';
import { OnEvent } from 'src/decorators.js';
import { DatabaseLock, FrameleafWorker, JobName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EmailRepository, EmailTemplate } from 'src/repositories/email.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { getExternalDomain } from 'src/utils/misc.js';

export const PHOTOGRAPHY_REMINDERS_CRON = 'PhotographyReminders';
const DAY = 86_400_000;
/** How many whole days ahead each reminder goes out. */
export const SELECTION_REMINDER_DAYS = 2;
export const EXPIRY_REMINDER_DAYS = 3;
/** How many whole days an unpaid order waits before its reminder. */
export const PAYMENT_REMINDER_DAYS = 3;

export type DueReminder = {
  kind: 'selection' | 'payment' | 'expiry';
  email: string;
  name: string;
  /** The date the reminder is about, for selection and expiry. */
  date?: string;
};

const days = (from: number, to: number) => Math.floor((to - from) / DAY);

/**
 * The reminders a gallery's clients are due today: a selection reminder two days before the selection
 * deadline to anyone who has not sent a selection, a payment reminder three days after an unpaid order,
 * and an expiry reminder three days before the gallery (or that client's link) closes.
 * ponytail: one fixed day per reminder keeps sending idempotent without stored state; a server down on that
 * day skips it. Store sent reminders on the recipient if that matters.
 */
export function dueReminders(value: PhotographyWorkflow, now: Date): DueReminder[] {
  const { reminders, selectionDeadline, expiresAt } = value.config;
  const today = now.getTime();
  const due: DueReminder[] = [];
  for (const recipient of value.recipients) {
    const closes = recipient.expiresAt ?? expiresAt;
    if (!recipient.email || recipient.revoked || (closes && Date.parse(closes) <= today)) {
      continue;
    }
    const to = { email: recipient.email, name: recipient.name };
    if (
      reminders?.selection &&
      selectionDeadline &&
      recipient.canProof &&
      days(today, Date.parse(selectionDeadline)) === SELECTION_REMINDER_DAYS &&
      value.rounds.every((round) => round.recipientId !== recipient.id)
    ) {
      due.push({ kind: 'selection', ...to, date: selectionDeadline });
    }
    if (!reminders?.paymentAndExpiry) {
      continue;
    }
    if (
      value.orders.some(
        (order) =>
          order.recipientId === recipient.id &&
          ['quoted', 'accepted'].includes(order.status) &&
          order.total > 0 &&
          days(Date.parse(order.createdAt), today) === PAYMENT_REMINDER_DAYS,
      )
    ) {
      due.push({ kind: 'payment', ...to });
    }
    if (closes && days(today, Date.parse(closes)) === EXPIRY_REMINDER_DAYS) {
      due.push({ kind: 'expiry', ...to, date: closes });
    }
  }
  return due;
}

/** Approved design (2026-11-04): Client workflow › Ready to share? › Selection and payment & expiry reminders. */
@Injectable()
export class PhotographyReminderService {
  private lock = false;
  constructor(
    private repository: PhotographyWorkflowRepository,
    private workspace: PhotographyWorkspaceRepository,
    private email: EmailRepository,
    private jobs: JobRepository,
    private cron: CronRepository,
    private database: DatabaseRepository,
    private configRepository: ConfigRepository,
    private metadata: SystemMetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PhotographyReminderService.name);
  }

  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
  async onConfigInit() {
    this.lock = await this.database.tryLock(DatabaseLock.PhotographyReminders);
    if (!this.lock) {
      return;
    }
    this.cron.create({
      name: PHOTOGRAPHY_REMINDERS_CRON,
      // Mid-morning server time, when a reminder is read rather than buried overnight.
      expression: '0 10 * * *',
      onTick: () => void this.sendReminders().catch((error) => this.logger.error(`Gallery reminders: ${error}`)),
      start: true,
    });
  }

  /** Queues today's reminder emails; returns how many. Nothing goes out without email and a public address. */
  async sendReminders(now = new Date()): Promise<number> {
    const { server, notifications, templates } = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.metadata, logger: this.logger },
      { withCache: true },
    );
    const baseUrl = getExternalDomain(server);
    if (!notifications.smtp.enabled || !baseUrl) {
      return 0;
    }
    let sent = 0;
    let cursor: string | null = null;
    for (;;) {
      const rows = await this.repository.remindable(cursor);
      for (const row of rows) {
        const due = dueReminders(row.value, now);
        if (due.length === 0) {
          continue;
        }
        const studioName =
          (await this.workspace.get(row.ownerId))?.value.brand?.name || (await this.repository.ownerName(row.ownerId));
        const galleryTitle = row.value.config.title;
        for (const reminder of due) {
          const { html, text } = await this.email.renderEmail({
            template: EmailTemplate.GALLERY_INVITE,
            data: {
              baseUrl,
              showBranding: templates.email.showBranding,
              reminder: reminder.kind,
              studioName: studioName || 'Your photographer',
              recipientName: reminder.name,
              galleryTitle,
              link: '',
              expiresAt: reminder.date
                ? `on ${new Date(reminder.date).toLocaleDateString('en', { dateStyle: 'long' })}`
                : undefined,
            },
          });
          const subject =
            reminder.kind === 'payment'
              ? `Your order from ${galleryTitle} is waiting`
              : reminder.kind === 'selection'
                ? `A reminder to choose your favourites from ${galleryTitle}`
                : `${galleryTitle} closes soon`;
          await this.jobs.queue({ name: JobName.SendMail, data: { to: reminder.email, subject, html, text } });
          sent++;
        }
      }
      if (rows.length < 200) {
        return sent;
      }
      cursor = rows.at(-1)!.id;
    }
  }
}
