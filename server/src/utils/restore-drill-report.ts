import { createPublicKey, verify } from 'node:crypto';
import type { DrillOutcome } from 'src/services/cloud-backup-drill.js';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { DRILL_FAILURE_WORDS, DRILL_STEPS } from 'src/services/cloud-backup-drill.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

/**
 * FL-879: the restore drill's report, as signed. The signature covers `DRILL_REPORT_SIGNING_PREFIX`
 * followed by the report's canonical JSON (keys sorted at every level, no spaces), with the server's
 * Ed25519 identity key. The downloaded file carries the report, the signature and the public key, so
 * anyone can check it came from this server and was not changed.
 */
export const DRILL_REPORT_FORMAT = 'frameleaf-restore-drill';
export const DRILL_REPORT_SIGNING_PREFIX = 'frameleaf-restore-drill-v1\n';

export type DrillReport = {
  report: typeof DRILL_REPORT_FORMAT;
  version: 1;
  id: string;
  server: string;
  target: string;
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  result: 'passed' | 'failed';
  failedStep: string | null;
  failure: string | null;
  steps: { step: string; state: 'passed' | 'failed' | 'not-reached' }[];
  backup: { manifestKey: string | null; createdAt: string | null };
  library: DrillOutcome['library'];
  restored: DrillOutcome['restored'];
  sample: { size: number; checked: number; matched: number };
  mismatches: DrillOutcome['mismatches'];
};

export type SignedDrillReport = {
  report: DrillReport;
  signature: {
    algorithm: 'Ed25519';
    prefix: string;
    keyFingerprint: string;
    publicKey: Record<string, unknown>;
    value: string;
  };
};

/** JSON with object keys sorted at every level and no whitespace: the same bytes on every server. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export const drillReportOf = (
  outcome: DrillOutcome,
  facts: {
    id: string;
    server: string;
    target: string;
    trigger: 'scheduled' | 'manual';
    startedAt: Date;
    finishedAt: Date;
  },
): DrillReport => {
  const failedAt = outcome.failedStep ? DRILL_STEPS.indexOf(outcome.failedStep) : -1;
  return {
    report: DRILL_REPORT_FORMAT,
    version: 1,
    id: facts.id,
    server: facts.server,
    target: facts.target,
    trigger: facts.trigger,
    startedAt: facts.startedAt.toISOString(),
    finishedAt: facts.finishedAt.toISOString(),
    durationSeconds: Math.max(0, Math.round((facts.finishedAt.getTime() - facts.startedAt.getTime()) / 1000)),
    result: outcome.result,
    failedStep: outcome.failedStep,
    failure: outcome.failedStep ? DRILL_FAILURE_WORDS[outcome.failedStep] : null,
    steps: DRILL_STEPS.map((step, index) => ({
      step,
      state: failedAt === -1 || index < failedAt ? 'passed' : index === failedAt ? 'failed' : 'not-reached',
    })),
    backup: { manifestKey: outcome.manifestKey, createdAt: outcome.backupFrom },
    library: outcome.library,
    restored: outcome.restored,
    sample: { size: outcome.sampleSize, checked: outcome.checked, matched: outcome.matched },
    mismatches: outcome.mismatches,
  };
};

export const signDrillReport = (report: DrillReport, signer: FrameleafKeySigner): SignedDrillReport => {
  if (!signer.signBytes) throw new Error('The server identity key cannot sign a report');
  return {
    report,
    signature: {
      algorithm: 'Ed25519',
      prefix: DRILL_REPORT_SIGNING_PREFIX,
      keyFingerprint: signer.kid,
      publicKey: { ...signer.publicJwk },
      value: signer
        .signBytes(Buffer.from(DRILL_REPORT_SIGNING_PREFIX + canonicalJson(report), 'utf8'))
        .toString('base64url'),
    },
  };
};

/** Whether a downloaded report is intact and signed by the key it names. */
export const verifyDrillReport = (signed: SignedDrillReport): boolean => {
  try {
    if (signed.signature.algorithm !== 'Ed25519' || signed.signature.prefix !== DRILL_REPORT_SIGNING_PREFIX)
      return false;
    const jwk = signed.signature.publicKey as { crv: string; kty: string; x: string };
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || ed25519Thumbprint(jwk) !== signed.signature.keyFingerprint)
      return false;
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    return verify(
      null,
      Buffer.from(DRILL_REPORT_SIGNING_PREFIX + canonicalJson(signed.report), 'utf8'),
      key,
      Buffer.from(signed.signature.value, 'base64url'),
    );
  } catch {
    return false;
  }
};
