/**
 * Presentation rules for the Frameleaf Cloud processing section (FL-159).
 *
 * The server decides everything: whether this server is linked, which consent version Frameleaf
 * Cloud requires, what the AI Wallet holds and what each job was charged. This module only turns
 * those facts into labels, the history list and the model choices, so the section never offers a
 * choice the server would refuse and never shows a figure the server did not send.
 */
import {
  CloudMlConnection,
  MlWorkload,
  type CloudMlConsentRecordDto,
  type CloudMlModelDto,
  type CloudMlSettlementDto,
  type CloudMlStatusResponseDto,
  type CloudMlWalletDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { FRAMELEAF_CLOUD_WORKLOADS, ML_WORKLOAD_ORDER } from './ml-destinations';

export const cloudConnectionLabelKey = (connection: CloudMlConnection): Translations => {
  switch (connection) {
    case CloudMlConnection.NotConfigured: {
      return 'admin.frameleaf_cloud_ml_connection_not_configured';
    }
    case CloudMlConnection.NotLinked: {
      return 'admin.frameleaf_cloud_ml_connection_not_linked';
    }
    case CloudMlConnection.Ready: {
      return 'admin.frameleaf_cloud_ml_connection_ready';
    }
    case CloudMlConnection.Unavailable: {
      return 'admin.frameleaf_cloud_ml_connection_unavailable';
    }
  }
};

/** Plain-language help for a connection that is not ready; null when it is. */
export const cloudConnectionHelpKey = (connection: CloudMlConnection): Translations | null => {
  switch (connection) {
    case CloudMlConnection.NotConfigured: {
      return 'admin.frameleaf_cloud_ml_connection_not_configured_help';
    }
    case CloudMlConnection.NotLinked: {
      return 'admin.frameleaf_cloud_ml_connection_not_linked_help';
    }
    case CloudMlConnection.Unavailable: {
      return 'admin.frameleaf_cloud_ml_connection_unavailable_help';
    }
    case CloudMlConnection.Ready: {
      return null;
    }
  }
};

export const formatUsd = (value: number, locale: string | undefined | null) =>
  new Intl.NumberFormat(locale ?? undefined, { style: 'currency', currency: 'USD' }).format(value);

/** A per-unit price: catalogue prices are often fractions of a cent, so up to four decimals are kept. */
export const formatUnitPrice = (value: number, locale: string | undefined | null) =>
  new Intl.NumberFormat(locale ?? undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);

export const formatDateTime = (value: string, locale: string | undefined | null) =>
  new Intl.DateTimeFormat(locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/**
 * Whether consent must be (re)recorded before Frameleaf Cloud may process anything: never recorded,
 * or recorded for an older version than the one the cloud requires now.
 */
export const cloudConsentNeeded = (status: Pick<CloudMlStatusResponseDto, 'consent' | 'destination'>): boolean => {
  if (!status.destination) {
    return false;
  }
  if (status.consent) {
    return status.consent.acceptedVersion === null || status.consent.outdated;
  }
  return status.destination.consent.acknowledgedAt === null;
};

/** Nothing is left to spend: new cloud jobs are refused, never sent elsewhere. */
export const walletIsEmpty = (wallet: Pick<CloudMlWalletDto, 'availableUsd'>): boolean => wallet.availableUsd <= 0;

/** The daily limit is used up for today. */
export const walletDailyCapReached = (wallet: Pick<CloudMlWalletDto, 'dailyCapUsd' | 'spentTodayUsd'>): boolean =>
  wallet.dailyCapUsd !== null && wallet.spentTodayUsd >= wallet.dailyCapUsd;

/** The workloads Frameleaf Cloud may be added for, in the order the section lists them. */
export const cloudWorkloads = (): MlWorkload[] =>
  ML_WORKLOAD_ORDER.filter((workload) => FRAMELEAF_CLOUD_WORKLOADS.includes(workload));

/** Models the catalogue offers for one workload, in the catalogue's order. */
export const modelsFor = (models: readonly CloudMlModelDto[], workload: MlWorkload): CloudMlModelDto[] =>
  models.filter((model) => model.workload === workload);

export type CloudHistoryEntry =
  | { kind: 'consent'; at: string; version: string; features: CloudMlConsentRecordDto['features'] }
  | { kind: 'revoked'; at: string; version: string }
  | {
      kind: 'settlement';
      at: string;
      workload: MlWorkload;
      costUsd: number;
      succeeded: boolean;
      cloudJobId: string;
    };

/**
 * The destination's history, newest first: every consent accepted or withdrawn and every settled
 * charge. This is what the prototype's "Provider action history" becomes for Frameleaf Cloud
 * (JobsManager.jsx:1720-1745): nothing here is sample data or an estimate.
 */
export const cloudHistory = (
  records: readonly CloudMlConsentRecordDto[],
  settlements: readonly CloudMlSettlementDto[],
): CloudHistoryEntry[] => {
  const entries: CloudHistoryEntry[] = [];
  for (const record of records) {
    entries.push({ kind: 'consent', at: record.acceptedAt, version: record.version, features: record.features });
    if (record.revokedAt) {
      entries.push({ kind: 'revoked', at: record.revokedAt, version: record.version });
    }
  }
  for (const settlement of settlements) {
    entries.push({
      kind: 'settlement',
      at: settlement.finishedAt,
      workload: settlement.workload,
      costUsd: settlement.costUsd,
      succeeded: settlement.succeeded,
      cloudJobId: settlement.cloudJobId,
    });
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
};
