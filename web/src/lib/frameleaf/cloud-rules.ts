import {
  CloudLinkState,
  LicenseState,
  type CloudStatusResponseDto,
  type LicenseProductsResponseDto,
  type LicenseStatusResponseDto,
} from '@frameleaf/sdk';
import { serverLicenceKind } from '$lib/frameleaf/cloud';

/**
 * FL-544: the one rule table for what a Frameleaf Cloud feature needs, as the user reads it.
 *
 * "Frameleaf Cloud" is the lifetime licence plus the plan, bought in one store trip. A gate never
 * asks the user to choose between them: it names the feature, says it is part of Frameleaf Cloud (or
 * pay as you go), and shows one button that opens the Get Frameleaf Cloud sheet. The server's copy of
 * the table is `server/src/utils/frameleaf-cloud-gates.ts`; the prototype's is
 * `src/settings-v2/cloud/have.js`.
 */
export type CloudFeature = 'remote' | 'backup' | 'signin' | 'buddy' | 'processing';
export type CloudLack = 'link' | 'cloud' | 'licence' | 'credit';

/** What this server has, as every gate reads it. */
export type CloudHave = {
  linked: boolean;
  licence: 'none' | 'server' | 'individual';
  /** A Frameleaf Cloud plan, active or in grace. */
  plan: boolean;
  /** Some AI credit is available. */
  credit: boolean;
  /** FRAMELEAF_CLOUD_URL is set. */
  configured: boolean;
  /** A store is known, so a purchase can be started. */
  store: boolean;
};

export const FEATURES: Record<
  CloudFeature,
  { nameKey: string; gateKey: string; whyKey: string; onKey: string; needs: 'cloud' | 'licence' | 'credit' }
> = {
  remote: {
    nameKey: 'frameleaf_feature_remote',
    gateKey: 'frameleaf_gate_remote',
    whyKey: 'frameleaf_why_remote',
    onKey: 'frameleaf_on_remote',
    needs: 'cloud',
  },
  backup: {
    nameKey: 'frameleaf_feature_backup',
    gateKey: 'frameleaf_gate_backup',
    whyKey: 'frameleaf_why_backup',
    onKey: 'frameleaf_on_backup',
    needs: 'cloud',
  },
  signin: {
    nameKey: 'frameleaf_feature_signin',
    gateKey: 'frameleaf_gate_signin',
    whyKey: 'frameleaf_why_signin',
    onKey: 'frameleaf_on_signin',
    needs: 'cloud',
  },
  buddy: {
    nameKey: 'frameleaf_feature_buddy',
    gateKey: 'frameleaf_gate_buddy',
    whyKey: 'frameleaf_why_buddy',
    onKey: 'frameleaf_on_buddy',
    needs: 'licence',
  },
  processing: {
    nameKey: 'frameleaf_feature_processing',
    gateKey: 'frameleaf_gate_processing',
    whyKey: 'frameleaf_why_processing',
    onKey: 'frameleaf_on_processing',
    needs: 'credit',
  },
};

/** What a feature still lacks on this server, in the order the sheet walks through them. */
export const missing = (feature: CloudFeature, have: CloudHave): CloudLack[] => {
  const { needs } = FEATURES[feature];
  const lacks: CloudLack[] = [];
  if (!have.linked) {
    lacks.push('link');
  }
  if (needs === 'cloud' && !have.plan) {
    lacks.push('cloud');
  }
  // Buddy Backup is the one feature an Individual licence never covers
  const licensed = feature === 'buddy' ? have.licence === 'server' : have.licence !== 'none';
  if (needs !== 'cloud' && !licensed) {
    lacks.push('licence');
  }
  if (needs === 'credit' && !have.credit) {
    lacks.push('credit');
  }
  return lacks;
};

/** The one button a gate shows: Frameleaf Cloud, unless only AI credit is short. */
export const gateButtonKey = (lacks: CloudLack[]): 'frameleaf_get_cloud' | 'frameleaf_add_ai_credit' =>
  lacks.length === 1 && lacks[0] === 'credit' ? 'frameleaf_add_ai_credit' : 'frameleaf_get_cloud';

const HELD: ReadonlySet<LicenseState> = new Set([LicenseState.Active, LicenseState.Grace]);

/** `CloudHave` from what the cloud manager holds (status, licence, products) and the wallet, when known. */
export const haveFrom = (
  status: Pick<CloudStatusResponseDto, 'state' | 'configured'> | null,
  license: Pick<LicenseStatusResponseDto, 'key' | 'plan'> | null,
  products: Pick<LicenseProductsResponseDto, 'storeUrl'> | null,
  wallet: { availableUsd: number } | null | undefined,
): CloudHave => {
  const configured = !!status?.configured && status.state !== CloudLinkState.NotConfigured;
  return {
    linked: configured && status?.state === CloudLinkState.Linked,
    licence: serverLicenceKind(license?.key) ?? 'none',
    plan: !!license?.plan && HELD.has(license.plan.state),
    credit: (wallet?.availableUsd ?? 0) > 0,
    configured,
    store: configured && !!products?.storeUrl,
  };
};
