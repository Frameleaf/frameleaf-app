/**
 * The one-time "Next steps" card on the library (design review finding 98). First-run setup tells
 * the administrator that Library Care, Cloud backup and Activity come after setup; this is where
 * the library delivers on it.
 *
 * Setup hands off with a navigation from its own page into the app, so the app's layout offers the
 * card to whoever arrives that way. The offer and the dismissal are remembered per account in this
 * browser, so a reload keeps the card and "Dismiss" removes it for good.
 */
const KEY = 'frameleaf:next-steps:v1';
const SETUP_PATH = '/auth/onboarding';

type Stored = 'offered' | 'dismissed';

const keyFor = (userId: string) => `${KEY}:${userId}`;

const read = (userId: string): Stored | null => {
  try {
    const value = localStorage.getItem(keyFor(userId));
    return value === 'offered' || value === 'dismissed' ? value : null;
  } catch {
    // Storage may be disabled: the card then lasts for this visit only.
    return null;
  }
};

const write = (userId: string, value: Stored) => {
  try {
    localStorage.setItem(keyFor(userId), value);
  } catch {
    // Not remembered; nothing else depends on it.
  }
};

/** Who the card is on offer to in this tab, so the page reacts when the layout makes the offer. */
const session = $state({ offeredTo: null as string | null, dismissedBy: null as string | null });

/** True when a navigation came from first-run setup. */
export const arrivedFromSetup = (from: { url: URL } | null | undefined): boolean =>
  !!from && (from.url.pathname === SETUP_PATH || from.url.pathname.startsWith(`${SETUP_PATH}/`));

/** Offer the card to this account. An account that already dismissed it is not asked again. */
export const offerNextSteps = (userId: string) => {
  if (read(userId) === 'dismissed') {
    return;
  }
  write(userId, 'offered');
  session.offeredTo = userId;
};

/** Whether the card should show for this account. */
export const nextStepsOffered = (userId: string | undefined): boolean => {
  if (!userId || session.dismissedBy === userId) {
    return false;
  }
  return session.offeredTo === userId || read(userId) === 'offered';
};

export const dismissNextSteps = (userId: string) => {
  write(userId, 'dismissed');
  session.dismissedBy = userId;
  if (session.offeredTo === userId) {
    session.offeredTo = null;
  }
};

/** For specs: forget what this tab knows. Storage is the caller's to clear. */
export const resetNextSteps = () => {
  session.offeredTo = null;
  session.dismissedBy = null;
};
