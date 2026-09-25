// Simulated Frameleaf account link and subscription changes for the prototype.
// Real linking uses the device flow on frameleaf.cloud; payment never happens here.

import { cloudPlans } from "./frameleaf-cloud-data.mjs";

export const SAMPLE_ACCOUNT = Object.freeze({
  id: "acc_7Q2M",
  email: "taylor@example.test",
  name: "Taylor",
});

/** The short code shown while this server waits for approval on frameleaf.cloud. */
export const SAMPLE_USER_CODE = "FLK-7Q2M";

export function linkAccount(state, now = Date.now()) {
  const at = new Date(now).toISOString();
  return {
    ...state,
    link: {
      ...state.link,
      status: "linked",
      account: { ...SAMPLE_ACCOUNT },
      userCode: null,
      linkedAt: at,
      lastContactAt: at,
    },
  };
}

export function unlinkAccount(state) {
  return {
    ...state,
    link: { ...state.link, status: "unlinked", account: null, linkedAt: null, userCode: null },
  };
}

function addPeriod(now, period) {
  const date = new Date(now);
  if (period === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** Checkout finished on frameleaf.cloud: the plan is active and its cloud features unlock. */
export function activatePlan(state, planId, now = Date.now()) {
  const plan = cloudPlans.find((entry) => entry.id === planId);
  if (!plan) throw new Error("Unknown Frameleaf Cloud plan");
  const linked = state.link.status === "linked" ? state : linkAccount(state, now);
  return {
    ...linked,
    license: {
      ...linked.license,
      state: "active",
      plan: plan.id,
      keyHint: null,
      renewsOn: addPeriod(now, plan.period),
      graceUntil: null,
      entitlements: {
        ...linked.license.entitlements,
        remoteAccess: true,
        cloudBackup: true,
        cloudProcessing: true,
      },
    },
  };
}

export function planById(id) {
  return cloudPlans.find((entry) => entry.id === id) ?? null;
}
