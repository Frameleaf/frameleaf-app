import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import AccountActivity from './AccountActivity.svelte';
import HouseholdActivity from './HouseholdActivity.svelte';

const sdk = vi.hoisted(() => ({
  getMyActivity: vi.fn(),
  getAccountActivityAdmin: vi.fn(),
  searchUsersAdmin: vi.fn(),
}));
const nav = vi.hoisted(() => ({ goto: vi.fn() }));
const user = vi.hoisted(() => ({ isAdmin: true, id: 'taylor', name: 'Taylor' }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user } }));

/** Thursday 12 November 2026, mid-afternoon, as the prototype's sample. */
const now = new Date(2026, 10, 12, 15, 0);
let next = 0;
const event = (createdAt: string, action: string, rest = {}) => ({
  id: `e${next++}`,
  source: 'account',
  userId: 'taylor',
  action,
  subject: '',
  detail: null,
  ipPrefix: null,
  deviceType: null,
  deviceOS: null,
  via: null,
  actorId: null,
  actorName: null,
  createdAt,
  ...rest,
});
const mac = { deviceType: 'Chrome', deviceOS: 'macOS' };
const windows = { deviceType: 'Chrome', deviceOS: 'Windows' };
const page = (events: unknown[], hasMore = false) => ({ events, hasMore });
const first = () => [
  event('2026-11-12T08:14:00', 'signed-in', { ...mac, via: 'relay', detail: 'frameleaf' }),
  event('2026-11-12T07:52:00', 'app-used', { subject: 'Claude', detail: 'asset.read' }),
  event('2026-11-11T21:30:00', 'dates-fixed', { detail: '248' }),
  event('2026-11-11T20:47:00', 'shared-link-created', { subject: 'Summer in Tofino', detail: 'ALBUM' }),
  event('2026-11-10T09:02:00', 'signed-out', mac),
  event('2026-11-09T21:15:00', 'two-factor-changed', { detail: 'moved' }),
  event('2026-11-09T21:00:00', 'two-factor-changed', { detail: 'admin-reset' }),
  event('2026-11-09T20:00:00', 'teleported'),
];
/** A page of rows from this afternoon, none of them a sign-in: an app using the library. */
const busy = (hasMore = true) =>
  page(
    Array.from({ length: 50 }, (_, index) =>
      event(`2026-11-12T14:${String(59 - index).padStart(2, '0')}:00`, 'app-used', { subject: 'Claude' }),
    ),
    hasMore,
  );

/** The end of the list coming into view, as a browser reports it (jsdom has no IntersectionObserver). */
const view = { visible: false, callbacks: new Set<() => void>() };
class FakeIntersectionObserver {
  #fire: () => void;
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.#fire = () => callback([{ isIntersecting: true }]);
  }
  observe() {
    view.callbacks.add(this.#fire);
    if (view.visible) {
      queueMicrotask(() => view.callbacks.has(this.#fire) && this.#fire());
    }
  }
  disconnect() {
    view.callbacks.delete(this.#fire);
  }
}
const scrollToEnd = () => {
  view.visible = true;
  for (const fire of view.callbacks) {
    fire();
  }
};

const row = (text: string | RegExp) => screen.getByText(text).closest('li') as HTMLElement;

describe('Account activity (FL-824)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    user.isAdmin = true;
    nav.goto.mockReset().mockResolvedValue(undefined);
    sdk.getMyActivity.mockReset().mockResolvedValue(page(first()));
  });

  it('opens on the last sign-in, then every row as a sentence, newest first by day', async () => {
    render(AccountActivity, { now });

    expect(await screen.findByRole('heading', { name: 'Your last sign-in was today at 8:14 AM' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'On Chrome on a Mac, away from home. Everything that happens with your account is listed here, newest first.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Only you and this server’s administrators can see this list.')).toBeInTheDocument();
    expect(sdk.getMyActivity).toHaveBeenCalledWith({ before: undefined, take: 50 });

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Today',
      'Yesterday',
      expect.stringContaining('Tuesday'),
      expect.stringContaining('Monday'),
    ]);
    expect(
      within(row('Signed in on Chrome on a Mac, away from home')).getByText(/· With your Frameleaf account/),
    ).toBeInTheDocument();
    expect(screen.getByText('Claude used your library')).toBeInTheDocument();
    expect(screen.getByText('Dates fixed on 248 photos')).toBeInTheDocument();
    // An action this page does not know yet gets a general sentence instead of failing.
    expect(screen.getByText('Something changed on your account')).toBeInTheDocument();
    expect(screen.getByText('That’s everything. Activity is kept for 400 days, then removed.')).toBeInTheDocument();
  });

  it('offers "This wasn’t me" on sign-ins and security changes you made, not on signing out or an administrator’s change', async () => {
    render(AccountActivity, { now });
    await screen.findByText('Claude used your library');

    expect(
      within(row('Signed in on Chrome on a Mac, away from home')).getByRole('button', { name: /^This wasn’t me/ }),
    ).toBeInTheDocument();
    expect(
      within(row('Two-step sign-in moved to a new phone')).getByRole('button', { name: /^This wasn’t me/ }),
    ).toBeInTheDocument();
    expect(within(row('Signed out on Chrome on a Mac')).queryByRole('button')).toBeNull();
    expect(within(row('Two-step sign-in turned off by an administrator')).queryByRole('button')).toBeNull();
    expect(within(row('Claude used your library')).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^This wasn’t me/ })).toHaveLength(2);
  });

  it('filters the rows already loaded with the chips, and shows dates fixed under All only', async () => {
    render(AccountActivity, { now });
    await screen.findByText('Claude used your library');

    await userEvent.click(screen.getByRole('button', { name: 'Sign-ins' }));
    expect(screen.getByRole('button', { name: 'Sign-ins' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Signed out on Chrome on a Mac')).toBeInTheDocument();
    expect(screen.queryByText('Claude used your library')).toBeNull();
    expect(screen.queryByText('Dates fixed on 248 photos')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Apps' }));
    expect(screen.getByText('Claude used your library')).toBeInTheDocument();
    expect(screen.queryByText('Dates fixed on 248 photos')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Sharing' }));
    expect(screen.getByText('Made a sharing link for “Summer in Tofino”')).toBeInTheDocument();

    // The chips never ask the server again.
    expect(sdk.getMyActivity).toHaveBeenCalledTimes(1);
  });

  it('says when a chip has nothing under it, and goes back to everything', async () => {
    sdk.getMyActivity.mockResolvedValue(page([event('2026-11-12T08:14:00', 'signed-in', mac)]));
    render(AccountActivity, { now });
    await screen.findByText('Signed in on Chrome on a Mac');

    await userEvent.click(screen.getByRole('button', { name: 'Sharing' }));
    expect(screen.getByText('Nothing shared in this list yet')).toBeInTheDocument();
    expect(screen.getByText(/There’s nothing of this kind to show\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all activity' }));
    expect(screen.getByText('Signed in on Chrome on a Mac')).toBeInTheDocument();
  });

  it('gets earlier activity on the cursor until all of it is shown', async () => {
    const events = first();
    sdk.getMyActivity
      .mockResolvedValueOnce(page(events, true))
      .mockResolvedValueOnce(page([event('2026-11-03T20:58:00', 'password-changed')]));
    render(AccountActivity, { now });
    await screen.findByText('Claude used your library');
    expect(screen.queryByText(/That’s everything/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show earlier activity' }));
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(sdk.getMyActivity).toHaveBeenLastCalledWith({ before: events.at(-1)?.id, take: 50 });
    expect(screen.getByText('Claude used your library')).toBeInTheDocument();
    expect(screen.getByText(/That’s everything/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
  });

  it('keeps the rows it has when earlier activity can’t be read, and lets you try again', async () => {
    sdk.getMyActivity
      .mockResolvedValueOnce(page(first(), true))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([event('2026-11-03T20:58:00', 'password-changed')]));
    render(AccountActivity, { now });
    await screen.findByText('Claude used your library');

    await userEvent.click(screen.getByRole('button', { name: 'Show earlier activity' }));
    expect(await screen.findByText('Earlier activity couldn’t be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Claude used your library')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
  });

  it('raises sign-ins that did not work in the last day, and "This wasn’t me" says what to do', async () => {
    user.isAdmin = false;
    sdk.getMyActivity.mockResolvedValue(
      page([
        event('2026-11-12T08:14:00', 'signed-in', mac),
        ...['23:42', '23:41', '23:41'].map((time) =>
          event(`2026-11-11T${time}:00`, 'sign-in-failed', { ...windows, via: 'direct', detail: 'password' }),
        ),
      ]),
    );
    render(AccountActivity, { now });

    expect(
      await screen.findByRole('heading', { name: 'The wrong password was entered 3 times in the last day' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The latest was on Chrome on a Windows PC, away from home at 11:42 PM\./),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Didn’t get in')).toHaveLength(3);

    await userEvent.click(screen.getByRole('button', { name: 'This wasn’t me' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Wrong password entered on Chrome on a Windows PC, away from home'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Yesterday at 11:42 PM')).toBeInTheDocument();
    expect(within(dialog).getByText('Change your password.')).toBeInTheDocument();
    // Someone who is not an administrator is told whom to ask.
    expect(within(dialog).getByText(/Ask the person who looks after this server\./)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Change my password' }));
    await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/user-settings?area=privacy&section=password'));
  });

  it('does not say when you last signed in, or that nothing is wrong, while earlier rows are not loaded', async () => {
    // every page is full of this afternoon's rows, and there is always more
    sdk.getMyActivity.mockImplementation(() => Promise.resolve(busy()));
    render(AccountActivity, { now });

    expect(
      await screen.findByRole('heading', { name: 'Nothing needs a look in what’s shown so far' }),
    ).toBeInTheDocument();
    expect(screen.getByText('This list goes further back. Show earlier activity to see the rest.')).toBeInTheDocument();
    // a few earlier pages load by themselves to find the answer, then it is left to the person
    await waitFor(() => expect(sdk.getMyActivity).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sdk.getMyActivity).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole('heading', { name: 'Nothing here needs a look' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show earlier activity' })).toBeInTheDocument();
  });

  it('looks further back by itself for the last sign-in, and says it once it is found', async () => {
    sdk.getMyActivity
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(
        page([event('2026-11-12T08:14:00', 'signed-in', mac), event('2026-11-10T09:00:00', 'signed-out', mac)], true),
      );
    render(AccountActivity, { now });

    expect(await screen.findByRole('heading', { name: 'Your last sign-in was today at 8:14 AM' })).toBeInTheDocument();
    // the rows reach back more than a day and hold a sign-in: nothing more is loaded by itself
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sdk.getMyActivity).toHaveBeenCalledTimes(2);
  });

  it('says a count of failed sign-ins may not be all of them while the last day is not all loaded', async () => {
    const failed = event('2026-11-12T14:59:30', 'sign-in-failed', { ...windows, detail: 'password' });
    sdk.getMyActivity.mockImplementation(() =>
      Promise.resolve(sdk.getMyActivity.mock.calls.length === 1 ? page([failed, ...busy().events], true) : busy()),
    );
    render(AccountActivity, { now });

    expect(
      await screen.findByRole('heading', { name: 'The wrong password was entered once in the last day' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/There may be more further back in the list\.$/)).toBeInTheDocument();
  });

  it('says the log holds no sign-in only once all of it is loaded', async () => {
    sdk.getMyActivity.mockResolvedValue(busy(false));
    render(AccountActivity, { now });

    expect(await screen.findByRole('heading', { name: 'Nothing here needs a look' })).toBeInTheDocument();
    expect(sdk.getMyActivity).toHaveBeenCalledTimes(1);
  });

  describe('as the end of the list comes into view', () => {
    beforeEach(() => {
      view.visible = false;
      view.callbacks.clear();
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('stops loading by itself after a few pages that add nothing under the chip', async () => {
      // every page holds sign-ins from days ago, and there is always more: nothing is ever shared
      sdk.getMyActivity.mockImplementation(() =>
        Promise.resolve(
          page([event('2026-11-08T08:00:00', 'signed-in', mac), event('2026-11-07T08:00:00', 'signed-out', mac)], true),
        ),
      );
      render(AccountActivity, { now });
      await screen.findByRole('heading', { name: /^Your last sign-in was on / });
      expect(sdk.getMyActivity).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole('button', { name: 'Sharing' }));
      scrollToEnd();
      await waitFor(() => expect(sdk.getMyActivity).toHaveBeenCalledTimes(4));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sdk.getMyActivity).toHaveBeenCalledTimes(4);
      expect(screen.getByText('Nothing shared in this list yet')).toBeInTheDocument();
      expect(screen.getByText(/There may be some further back\./)).toBeInTheDocument();

      // going on is left to the person, one page at a time
      await userEvent.click(screen.getByRole('button', { name: 'Show earlier activity' }));
      await waitFor(() => expect(sdk.getMyActivity).toHaveBeenCalledTimes(5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sdk.getMyActivity).toHaveBeenCalledTimes(5);

      // another chip starts the count again
      await userEvent.click(screen.getByRole('button', { name: 'Apps' }));
      await waitFor(() => expect(sdk.getMyActivity).toHaveBeenCalledTimes(8));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sdk.getMyActivity).toHaveBeenCalledTimes(8);
    });

    it('keeps loading while each page adds rows to what is shown', async () => {
      let calls = 0;
      sdk.getMyActivity.mockImplementation(() =>
        Promise.resolve(page([event('2026-11-08T08:00:00', 'signed-in', mac)], ++calls < 7)),
      );
      render(AccountActivity, { now });
      await screen.findByRole('heading', { name: /^Your last sign-in was on / });

      scrollToEnd();
      expect(await screen.findByText(/That’s everything/)).toBeInTheDocument();
      expect(sdk.getMyActivity).toHaveBeenCalledTimes(7);
    });
  });

  it('says so when nothing has happened yet', async () => {
    sdk.getMyActivity.mockResolvedValue(page([]));
    render(AccountActivity, { now });

    expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign-ins' })).toBeNull();
  });

  it('shows rows the size of the real ones while it loads', () => {
    sdk.getMyActivity.mockReturnValue(new Promise(() => {}));
    render(AccountActivity, { now });

    expect(screen.getByRole('heading', { name: 'Getting your activity…' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Loading activity' })).toHaveAttribute('aria-busy', 'true');
  });

  it('says it couldn’t load and tries again, without taking the page away', async () => {
    sdk.getMyActivity.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page(first()));
    render(AccountActivity, { now });

    expect(await screen.findByRole('heading', { name: 'Your activity couldn’t be loaded' })).toBeInTheDocument();
    expect(screen.getByText(/the rest of your settings work as usual/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Claude used your library')).toBeInTheDocument();
  });
});

describe('Activity log for administrators (FL-824)', () => {
  const person = (id: string, name: string) => ({
    id,
    name,
    email: `${id}@example.test`,
    isAdmin: id === 'taylor',
    deletedAt: null,
    avatarColor: 'blue',
    profileImagePath: '',
    profileChangedAt: '2026-01-01T00:00:00.000Z',
  });
  const onWho = vi.fn();

  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    onWho.mockReset();
    nav.goto.mockReset().mockResolvedValue(undefined);
    sdk.searchUsersAdmin.mockReset().mockResolvedValue([person('taylor', 'Taylor'), person('morgan', 'Morgan')]);
    sdk.getAccountActivityAdmin.mockReset().mockResolvedValue(
      page([
        event('2026-11-12T08:14:00', 'signed-in', { ...mac, via: 'home', detail: 'password' }),
        event('2026-11-12T07:52:00', 'app-used', { userId: 'morgan', subject: 'Claude', detail: 'asset.read' }),
        event('2026-11-09T17:10:00', 'quota-changed', {
          source: 'admin',
          userId: 'morgan',
          actorId: 'taylor',
          actorName: 'Taylor',
          detail: '200000000000',
        }),
      ]),
    );
  });

  it('names who each row is about, with the picture of whoever did it', async () => {
    render(HouseholdActivity, { onWho, now });

    expect(
      await screen.findByRole('heading', { name: 'Everyone’s account activity, in one list' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/for all 2 people, newest first/)).toBeInTheDocument();
    expect(sdk.getAccountActivityAdmin).toHaveBeenCalledWith({ before: undefined, take: 50, userId: undefined });

    const signedIn = row('Taylor signed in on Chrome on a Mac, at home');
    expect(within(signedIn).getByText(/With their password/)).toBeInTheDocument();
    expect(signedIn.querySelector('.face')).toHaveAttribute('title', 'Taylor');
    // An app using Morgan's library shows Morgan; what an administrator did shows the administrator.
    expect(row('Claude used Morgan’s library').querySelector('.face')).toHaveAttribute('title', 'Morgan');
    expect(row(/^Taylor changed Morgan’s space to/).querySelector('.face')).toHaveAttribute('title', 'Taylor');
    expect(screen.queryByRole('button', { name: /This wasn’t me/ })).toBeNull();
  });

  it('narrows the list to one person through the server, and keeps the chips on the page', async () => {
    const view = render(HouseholdActivity, { onWho, now });
    await screen.findByText('Claude used Morgan’s library');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Whose activity' }), 'morgan');
    expect(onWho).toHaveBeenCalledWith('morgan');
    await view.rerender({ who: 'morgan', onWho, now });
    await waitFor(() =>
      expect(sdk.getAccountActivityAdmin).toHaveBeenLastCalledWith({ before: undefined, take: 50, userId: 'morgan' }),
    );

    const calls = sdk.getAccountActivityAdmin.mock.calls.length;
    await userEvent.click(await screen.findByRole('button', { name: 'Security' }));
    expect(screen.getByText(/^Taylor changed Morgan’s space to/)).toBeInTheDocument();
    expect(screen.queryByText('Claude used Morgan’s library')).toBeNull();
    expect(sdk.getAccountActivityAdmin).toHaveBeenCalledTimes(calls);
  });

  it('raises wrong passwords for one person and opens their page', async () => {
    sdk.getAccountActivityAdmin.mockResolvedValue(
      page(
        ['14:42', '14:41'].map((time) =>
          event(`2026-11-12T${time}:00`, 'sign-in-failed', { userId: 'morgan', ...windows, detail: 'password' }),
        ),
      ),
    );
    render(HouseholdActivity, { onWho, now });

    expect(
      await screen.findByRole('heading', { name: 'The wrong password was entered for Morgan 2 times in the last day' }),
    ).toBeInTheDocument();
    const failed = screen.getAllByText('Wrong password entered for Morgan on Chrome on a Windows PC');
    expect(failed).toHaveLength(2);
    expect(failed[0].closest('li')?.querySelector('.face')).toHaveAttribute('title', 'Morgan');
    await userEvent.click(
      within(failed[0].closest('li') as HTMLElement).getByRole('button', { name: 'Open Morgan’s page' }),
    );
    expect(nav.goto).toHaveBeenCalledWith('/user-settings?area=users&section=accounts&user=morgan');
  });

  it('counts the last day’s failed sign-ins with a request of its own, whatever the list has loaded', async () => {
    const failed = ['14:42', '14:41', '14:40'].map((time) =>
      event(`2026-11-12T${time}:00`, 'sign-in-failed', { userId: 'morgan', ...windows, detail: 'password' }),
    );
    sdk.getAccountActivityAdmin.mockImplementation(({ action }: { action?: string }) =>
      // the list's own first page holds no failed sign-in: they are further back
      Promise.resolve(action === 'sign-in-failed' ? page(failed) : busy()),
    );
    render(HouseholdActivity, { onWho, now });

    expect(
      await screen.findByRole('heading', { name: 'The wrong password was entered for Morgan 3 times in the last day' }),
    ).toBeInTheDocument();
    expect(sdk.getAccountActivityAdmin).toHaveBeenCalledWith({
      action: 'sign-in-failed',
      $from: new Date(now.getTime() - 86_400_000).toISOString(),
      take: 200,
      userId: undefined,
    });
    expect(screen.queryByText(/There may be more further back in the list/)).toBeNull();
  });

  it('says the count may not be all of them when the last day could not be asked for', async () => {
    const failed = event('2026-11-12T14:59:30', 'sign-in-failed', { userId: 'morgan', detail: 'password' });
    sdk.getAccountActivityAdmin.mockImplementation(({ action }: { action?: string }) =>
      action === 'sign-in-failed'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(page([failed, ...busy().events], true)),
    );
    render(HouseholdActivity, { onWho, now });

    expect(
      await screen.findByRole('heading', { name: 'The wrong password was entered for Morgan once in the last day' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/There may be more further back in the list\.$/)).toBeInTheDocument();
  });

  it('still shows what happened when the names can’t be read, and tries the names again by themselves', async () => {
    sdk.searchUsersAdmin
      .mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([person('taylor', 'Taylor'), person('morgan', 'Morgan')]);
    render(HouseholdActivity, { onWho, now });

    expect(await screen.findByText('Someone signed in on Chrome on a Mac, at home')).toBeInTheDocument();
    expect(screen.getByText('Claude used Someone’s library')).toBeInTheDocument();
    expect(screen.getByText('Names and pictures couldn’t be loaded, so each row says “Someone”')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'The activity log couldn’t be loaded' })).toBeNull();
    const calls = sdk.getAccountActivityAdmin.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Taylor signed in on Chrome on a Mac, at home')).toBeInTheDocument();
    expect(screen.queryByText(/Names and pictures couldn’t be loaded/)).toBeNull();
    // only the names were asked for again
    expect(sdk.getAccountActivityAdmin).toHaveBeenCalledTimes(calls);
  });

  it('says it couldn’t load, and that the rest of Users works', async () => {
    sdk.getAccountActivityAdmin.mockRejectedValue(new Error('offline'));
    render(HouseholdActivity, { onWho, now });

    expect(await screen.findByRole('heading', { name: 'The activity log couldn’t be loaded' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
