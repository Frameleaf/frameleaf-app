import { addMessages, t } from 'svelte-i18n';
import { get } from 'svelte/store';
import en from '$i18n/en.json';
import {
  activityDay,
  activityKind,
  coversLastDay,
  describeActivity,
  filterActivity,
  groupByDay,
  lastSignIn,
  offersWasntMe,
  pictureOf,
  recentFailures,
  type ActivityEvent,
} from '$lib/frameleaf/account-activity';

/** FL-824: account activity in plain words. */

beforeAll(() => {
  addMessages('dev', en);
});

let next = 0;
const event = (action: string, rest: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${next++}`,
  source: 'account',
  userId: 'u1',
  action,
  subject: '',
  detail: null,
  ipPrefix: null,
  deviceType: null,
  deviceOS: null,
  via: null,
  actorId: null,
  actorName: null,
  createdAt: '2026-11-12T08:14:00.000',
  ...rest,
});
const mac = { deviceType: 'Chrome', deviceOS: 'macOS' };
const say = (action: string, rest: Partial<ActivityEvent> = {}, name?: string) =>
  describeActivity(get(t), event(action, rest), { name, formatBytes: (bytes) => `${bytes / 1e9} GB` });

/** Every action the server records (`AccountEventAction` in server/src/enum.ts). */
const SERVER_ACTIONS = [
  'signed-in',
  'sign-in-failed',
  'signed-out',
  'session-revoked',
  'password-changed',
  'pin-changed',
  'two-factor-changed',
  'passkey-added',
  'passkey-removed',
  'passkeys-removed-by-admin',
  'api-key-created',
  'api-key-deleted',
  'shared-link-created',
  'shared-link-removed',
  'partner-added',
  'partner-removed',
  'item-shared',
  'dates-fixed',
  'app-connected',
  'app-disconnected',
  'app-denied',
  'app-used',
];

describe(describeActivity.name, () => {
  it('has a sentence of its own for every action the server records, about you and about someone else', () => {
    for (const action of SERVER_ACTIONS) {
      const mine = say(action, { subject: 'Thing' });
      const theirs = say(action, { subject: 'Thing' }, 'Morgan');
      expect(mine.text, action).not.toBe('Something changed on your account');
      expect(mine.text, action).not.toContain('frameleaf_');
      expect(theirs.text, action).not.toBe('Something changed on Morgan’s account');
      expect(theirs.text, action).not.toContain('frameleaf_');
      expect(theirs.text, action).toMatch(/Morgan|An administrator/);
    }
  });

  it('says something true about an action it does not know', () => {
    expect(say('teleported').text).toBe('Something changed on your account');
    expect(say('teleported', {}, 'Morgan').text).toBe('Something changed on Morgan’s account');
    expect(say('teleported').kind).toBe('other');
  });

  it('says the device and whether it was at home, only when the server knows', () => {
    expect(say('signed-in', { ...mac, via: 'home', detail: 'two-factor' })).toMatchObject({
      text: 'Signed in on Chrome on a Mac, at home',
      note: 'With your password and a two-step code',
    });
    expect(say('signed-in', { ...mac, via: 'relay', detail: 'passkey' }, 'Morgan')).toMatchObject({
      text: 'Morgan signed in on Chrome on a Mac, away from home',
      note: 'With a passkey',
    });
    expect(say('signed-in').text).toBe('Signed in');
    expect(say('signed-in', { detail: 'frameleaf' }, 'Emma').note).toBe('With their Frameleaf account');
  });

  it('marks a sign-in that did not work, and says which step failed', () => {
    expect(say('sign-in-failed', { ...mac, via: 'direct', detail: 'password' })).toMatchObject({
      text: 'Wrong password entered on Chrome on a Mac, away from home',
      warn: 'didnt-get-in',
    });
    expect(say('sign-in-failed', { detail: 'two-factor' }, 'Morgan')).toMatchObject({
      text: 'Wrong two-step code entered for Morgan',
      note: 'The password was right',
    });
    expect(say('sign-in-failed', { detail: 'passkey' }).text).toBe('A passkey sign-in didn’t work');
  });

  it('names what changed from the detail the server recorded', () => {
    expect(say('pin-changed', { detail: 'set' }).text).toBe('Locked PIN set');
    expect(say('pin-changed', { detail: 'reset' }, 'Emma').text).toBe('Emma reset their Locked PIN');
    expect(say('two-factor-changed', { detail: 'enabled' }).text).toBe('Two-step sign-in turned on');
    expect(say('two-factor-changed', { detail: 'disabled' }).text).toBe('Two-step sign-in turned off');
    expect(say('two-factor-changed', { detail: 'moved' }, 'Taylor').text).toBe(
      'Taylor moved two-step sign-in to a new phone',
    );
    expect(say('two-factor-changed', { detail: 'admin-reset' }).text).toBe(
      'Two-step sign-in turned off by an administrator',
    );
    expect(say('passkeys-removed-by-admin', { detail: '2' }, 'Morgan').text).toBe(
      'An administrator removed all of Morgan’s passkeys (2)',
    );
    expect(say('item-shared', { subject: 'Morgan', detail: '12' }).text).toBe('Shared 12 photos with Morgan');
    expect(say('item-shared', { subject: 'Morgan', detail: '1' }).text).toBe('Shared 1 photo with Morgan');
    expect(say('dates-fixed', { detail: '248' }, 'Taylor').text).toBe('Taylor fixed the dates on 248 photos');
    expect(say('shared-link-created', { subject: 'Summer in Tofino', detail: 'ALBUM' })).toMatchObject({
      text: 'Made a sharing link for “Summer in Tofino”',
      note: 'Anyone with the link can see the album',
    });
    expect(say('shared-link-created').text).toBe('Made a sharing link');
    expect(
      say('session-revoked', { subject: 'macOS · Safari', deviceType: 'Frameleaf', deviceOS: 'iOS' }),
    ).toMatchObject({ text: 'Signed out a device: Safari on a Mac', note: 'From Frameleaf app on an iPhone' });
  });

  it('says why an app was disconnected', () => {
    expect(say('app-disconnected', { subject: 'Photo Frame Pro', detail: 'token-reused' })).toMatchObject({
      text: 'Photo Frame Pro was disconnected to keep your library safe',
      warn: 'cut-off',
    });
    expect(say('app-disconnected', { subject: 'Home Assistant', detail: 'app-signed-out' }).text).toBe(
      'Home Assistant disconnected itself',
    );
    expect(say('app-disconnected', { subject: 'Slideshow Maker', detail: 'app-deleted' }, 'Morgan').text).toBe(
      'Slideshow Maker was removed from Morgan’s library by an administrator',
    );
    expect(say('app-disconnected', { subject: 'ChatGPT', detail: 'removed' })).toMatchObject({
      text: 'Disconnected ChatGPT',
      note: 'It can no longer open your library',
    });
    expect(say('app-connected', { subject: 'Claude', detail: 'asset.read album.read' }).note).toBe(
      'It can look at your library, and can’t change anything',
    );
    expect(say('app-connected', { subject: 'Claude', detail: 'asset.read asset.upload' }).note).toBe(
      'It can look at your library and add to it',
    );
  });

  it('says what an administrator did to an account, and who', () => {
    const admin = { source: 'admin', actorId: 'a1', actorName: 'Taylor' };
    expect(say('quota-changed', { ...admin, detail: '200000000000' }, 'Emma').text).toBe(
      'Taylor changed Emma’s space to 200 GB',
    );
    expect(say('quota-changed', admin, 'Emma').text).toBe('Taylor removed Emma’s space limit');
    expect(say('password-reset', { ...admin, detail: 'change-required' }, 'Morgan').text).toBe(
      'Taylor reset Morgan’s password',
    );
    expect(say('account-updated', { ...admin, detail: 'two-factor-reset' }, 'Morgan').text).toBe(
      'Taylor turned off two-step sign-in for Morgan',
    );
    expect(say('account-created', { ...admin, actorName: null }, 'Emma').text).toBe(
      'An administrator created Emma’s account',
    );
    // The rest of the administrator history keeps its own sentence, with whose account and who.
    expect(say('account-updated', { ...admin, detail: 'uploads-paused' }, 'Emma')).toMatchObject({
      note: 'Emma’s account · by Taylor',
      kind: 'security',
      wasntMe: false,
    });
  });
});

describe(offersWasntMe.name, () => {
  it('is offered on sign-ins, failed sign-ins and security changes you made', () => {
    for (const action of [
      'signed-in',
      'sign-in-failed',
      'password-changed',
      'pin-changed',
      'two-factor-changed',
      'passkey-added',
      'passkey-removed',
    ]) {
      expect(say(action).wasntMe, action).toBe(true);
    }
  });

  it('is not offered on signing out, on what an administrator did, or outside your own page', () => {
    for (const action of ['signed-out', 'session-revoked', 'passkeys-removed-by-admin', 'app-used', 'item-shared']) {
      expect(say(action).wasntMe, action).toBe(false);
    }
    expect(say('two-factor-changed', { detail: 'admin-reset' }).wasntMe).toBe(false);
    expect(say('signed-in', {}, 'Morgan').wasntMe).toBe(false);
  });
});

describe('chips', () => {
  it('puts each action under its chip, dates fixed under All only, and administrator actions under Security', () => {
    expect(activityKind(event('signed-out'))).toBe('signins');
    expect(activityKind(event('passkey-added'))).toBe('security');
    expect(activityKind(event('partner-added'))).toBe('sharing');
    expect(activityKind(event('api-key-created'))).toBe('apps');
    expect(activityKind(event('dates-fixed'))).toBe('other');
    expect(activityKind(event('quota-changed', { source: 'admin' }))).toBe('security');

    const events = [event('signed-in'), event('dates-fixed'), event('app-used'), event('password-changed')];
    expect(filterActivity(events, 'all')).toHaveLength(4);
    expect(filterActivity(events, 'signins').map((item) => item.action)).toEqual(['signed-in']);
    expect(filterActivity(events, 'apps').map((item) => item.action)).toEqual(['app-used']);
    expect(filterActivity(events, 'sharing')).toEqual([]);
  });
});

describe('days', () => {
  const now = new Date(2026, 10, 12, 15, 0);

  it('names today, yesterday, a day this year and a day in another year', () => {
    expect(activityDay(get(t), '2026-11-12T08:14:00', now, 'en')).toBe('Today');
    expect(activityDay(get(t), '2026-11-11T23:42:00', now, 'en')).toBe('Yesterday');
    expect(activityDay(get(t), '2026-11-10T18:40:00', now, 'en')).toMatch(/Tuesday.*November 10|Tuesday.*10 November/);
    expect(activityDay(get(t), '2025-06-19T10:15:00', now, 'en')).toMatch(/2025/);
  });

  it('groups rows by day in the order they came', () => {
    const events = [
      event('signed-in', { createdAt: '2026-11-12T08:14:00' }),
      event('app-used', { createdAt: '2026-11-12T07:52:00' }),
      event('signed-in', { createdAt: '2026-11-11T20:10:00' }),
    ];
    const days = groupByDay(events, (createdAt) => activityDay(get(t), createdAt, now, 'en'));
    expect(days.map((day) => [day.day, day.events.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ]);
  });
});

describe('the answer at the top', () => {
  const now = new Date('2026-11-12T15:00:00.000Z');

  it('counts sign-ins that did not work in the last day, for the account with the most', () => {
    const events = [
      event('signed-in', { createdAt: '2026-11-12T08:14:00.000Z' }),
      event('sign-in-failed', { userId: 'u2', createdAt: '2026-11-12T05:42:00.000Z', detail: 'password' }),
      event('sign-in-failed', { userId: 'u2', createdAt: '2026-11-12T05:41:00.000Z', detail: 'password' }),
      event('sign-in-failed', { userId: 'u1', createdAt: '2026-11-12T04:00:00.000Z', detail: 'two-factor' }),
      event('sign-in-failed', { userId: 'u2', createdAt: '2026-11-10T05:41:00.000Z', detail: 'password' }),
    ];
    const failures = recentFailures(events, now);
    expect(failures?.events.map((item) => item.userId)).toEqual(['u2', 'u2']);
    expect(failures?.passwordOnly).toBe(true);
    expect(recentFailures([events[3]], now)?.passwordOnly).toBe(false);
    expect(recentFailures([events[0], events[4]], now)).toBeUndefined();
    expect(lastSignIn(events)?.createdAt).toBe('2026-11-12T08:14:00.000Z');
  });

  it('counts many sign-ins that did not work for one account, in the order they came', () => {
    const events = Array.from({ length: 500 }, (_, index) =>
      event('sign-in-failed', {
        userId: index % 5 === 0 ? 'u1' : 'u2',
        createdAt: new Date(now.getTime() - index * 1000).toISOString(),
      }),
    );
    const failures = recentFailures(events, now);
    expect(failures?.events).toHaveLength(400);
    expect(failures?.events.every((item) => item.userId === 'u2')).toBe(true);
    expect(failures?.events[0]).toBe(events[1]);
  });

  it('knows whether the rows loaded hold the whole last day', () => {
    const today = [event('app-used', { createdAt: '2026-11-12T14:00:00.000Z' })];
    const older = [...today, event('app-used', { createdAt: '2026-11-10T14:00:00.000Z' })];
    // earlier rows are still on the server, and the oldest one loaded is from today
    expect(coversLastDay(today, true, now)).toBe(false);
    // the oldest row loaded is more than a day old, so the last day is all here
    expect(coversLastDay(older, true, now)).toBe(true);
    // nothing earlier on the server
    expect(coversLastDay(today, false, now)).toBe(true);
    expect(coversLastDay([], false, now)).toBe(true);
  });
});

describe(pictureOf.name, () => {
  it('is whoever did it, else who the row is about', () => {
    expect(pictureOf(event('sign-in-failed', { userId: 'morgan' }))).toBe('morgan');
    expect(pictureOf(event('quota-changed', { source: 'admin', userId: 'emma', actorId: 'taylor' }))).toBe('taylor');
  });
});
