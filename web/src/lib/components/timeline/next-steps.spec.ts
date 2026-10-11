import { beforeEach, describe, expect, it } from 'vitest';
import {
  arrivedFromSetup,
  dismissNextSteps,
  nextStepsOffered,
  offerNextSteps,
  resetNextSteps,
} from '$lib/components/timeline/next-steps.svelte';

describe('next steps offer', () => {
  beforeEach(() => {
    localStorage.clear();
    resetNextSteps();
  });

  it('knows a navigation that came from first-run setup', () => {
    expect(arrivedFromSetup({ url: new URL('http://localhost/auth/onboarding') })).toBe(true);
    expect(arrivedFromSetup({ url: new URL('http://localhost/auth/onboarding?step=ready') })).toBe(true);
    expect(arrivedFromSetup({ url: new URL('http://localhost/auth/login') })).toBe(false);
    expect(arrivedFromSetup(null)).toBe(false);
    // a public share page opened directly: the navigation has a source with no address
    expect(arrivedFromSetup({ url: null })).toBe(false);
  });

  it('is offered to the account that finished setup, and survives a reload', () => {
    expect(nextStepsOffered('admin')).toBe(false);
    offerNextSteps('admin');
    expect(nextStepsOffered('admin')).toBe(true);
    expect(nextStepsOffered('someone-else')).toBe(false);
    expect(nextStepsOffered(undefined)).toBe(false);
    // A reload forgets the tab's own state; the browser remembers the offer.
    resetNextSteps();
    expect(nextStepsOffered('admin')).toBe(true);
  });

  it('is gone for good once dismissed, even if setup is passed through again', () => {
    offerNextSteps('admin');
    dismissNextSteps('admin');
    expect(nextStepsOffered('admin')).toBe(false);
    resetNextSteps();
    offerNextSteps('admin');
    expect(nextStepsOffered('admin')).toBe(false);
  });
});
