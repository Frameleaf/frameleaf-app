import { getConfig, getConfigDefaults, LoginResponseDto, updateConfig, VersionCheckFrequency } from '@frameleaf/sdk';
import { expect, Page, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { asBearerAuth, baseUrl, utils } from 'src/utils.js';

/**
 * FL-71: the Command Center settings (`/user-settings?area=<area>&section=<section>`). Every page
 * edits one settings draft; the settings bar (`SettingsSaveBar.svelte`) reviews and saves it.
 */
const trashUrl = '/user-settings?area=storage&section=trash';
const configurationUrl = '/user-settings?area=server&section=configuration';
const notificationsUrl = '/user-settings?area=notifications&section=notifications';
const versionCheckUrl = '/user-settings?area=server&section=version-check';

// i18n/en.json
const labels = {
  trashDays: 'Keep deleted photos for, in days', // frameleaf_deleted_keep_photos_days (FL-365)
  trashKeep: 'Keep deleted photos for', // frameleaf_deleted_keep_photos
  bar: 'Unsaved settings', // frameleaf_settings_draft_bar_label
  discard: 'Discard', // frameleaf_settings_draft_discard
  review: 'Review changes', // frameleaf_settings_draft_review
  reviewTitle: 'Review settings changes', // frameleaf_settings_draft_review_title
  save: 'Save changes', // frameleaf_settings_draft_save
  resetPage: 'Reset this page', // frameleaf_settings_draft_reset_page
  saved: 'Settings saved.', // frameleaf_settings_draft_notice_saved
  discarded: 'Unsaved changes discarded.', // frameleaf_settings_draft_notice_discarded
  defaultsRestored: 'Defaults restored to your draft. Review changes to save them.', // frameleaf_settings_draft_notice_defaults
  importedOne: '1 setting from the file is in your draft. Review changes to save it.', // frameleaf_settings_draft_notice_imported
  conflict: 'Settings were changed elsewhere since you opened this page.', // frameleaf_settings_draft_conflict (prefix)
  // FL-368 Server & updates › Copy settings.
  exportSettings: 'Save to a file', // frameleaf_srvadv_copy_save_action
  importSettings: 'Load from a file', // frameleaf_srvadv_copy_load_action
  // ADMIN-P3 "The emails themselves".
  changeWording: 'Change the wording of emails', // frameleaf_notify_wording_change
  editWelcome: 'Edit the wording of the Welcome email', // frameleaf_notify_wording_edit_label
  welcome: 'Welcome email', // frameleaf_notify_wording_welcome
  preview: 'Preview with sample names', // frameleaf_notify_wording_preview
  // FL-368 Server & updates › Updates: the switch and the frequency are one choice.
  lookForUpdates: 'Look for updates', // frameleaf_server_updates_look
  never: 'Never', // frameleaf_server_updates_look_never
  daily: 'Every day', // frameleaf_server_updates_look_daily
  weekly: 'Every week', // frameleaf_server_updates_look_weekly
  updates: 'Updates', // frameleaf_cc_section_versions
};

/**
 * FL-365: Deleted items offers lengths in a list and a box for another length; the box shows for a
 * length the list does not have. Choosing "Another length…" shows it for any length.
 */
const trashDays = async (page: Page) => {
  const field = page.getByLabel(labels.trashDays, { exact: true });
  if (!(await field.isVisible())) {
    await page.getByRole('combobox', { name: labels.trashKeep, exact: true }).selectOption('custom');
  }
  return field;
};
const fillTrashDays = async (page: Page, value: string) => {
  const field = await trashDays(page);
  await field.fill(value);
};

const frequencyLabel = { [VersionCheckFrequency.Daily]: labels.daily, [VersionCheckFrequency.Weekly]: labels.weekly };

/** One choice of "Look for updates" on the Updates page. */
const lookChoice = (page: Page, name: string) =>
  page.getByRole('group', { name: labels.lookForUpdates }).getByRole('button', { name, exact: true });

const readConfig = (admin: LoginResponseDto) => getConfig({ headers: asBearerAuth(admin.accessToken) });

const savedTrashDays = async (admin: LoginResponseDto) => {
  const config = await readConfig(admin);
  return config.trash.days;
};

const setTrashDays = async (admin: LoginResponseDto, days: number) => {
  const config = await readConfig(admin);
  await updateConfig(
    { adminConfigDto: { ...config, trash: { ...config.trash, days } } },
    { headers: asBearerAuth(admin.accessToken) },
  );
};

/** Opens the review from the settings bar and saves every pending change. */
const reviewAndSave = async (page: Page) => {
  const bar = page.getByRole('region', { name: labels.bar });
  await bar.getByRole('button', { name: labels.review }).click();
  const review = page.getByRole('dialog', { name: labels.reviewTitle });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: labels.save }).click();
  await expect(page.getByText(labels.saved)).toBeVisible();
  await expect(bar).toBeHidden();
};

test.describe('Command Center settings', () => {
  let admin: LoginResponseDto;

  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async ({ context }) => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test.afterEach(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  // FL-71: a change is held in the draft until it is reviewed and saved from the settings bar; it then persists.
  test('saves a changed setting through the settings bar review', async ({ page }) => {
    const before = await readConfig(admin);
    const days = before.trash.days + 15;

    await page.goto(trashUrl);
    const field = await trashDays(page);
    await expect(field).toHaveValue(String(before.trash.days));
    await field.fill(String(days));

    const bar = page.getByRole('region', { name: labels.bar });
    await expect(bar).toBeVisible();
    // Nothing is saved while the change is only in the draft.
    expect(await savedTrashDays(admin)).toBe(before.trash.days);

    await bar.getByRole('button', { name: labels.review }).click();
    const review = page.getByRole('dialog', { name: labels.reviewTitle });
    await expect(review.getByText(String(days), { exact: true })).toBeVisible();
    await review.getByRole('button', { name: labels.save }).click();
    await expect(page.getByText(labels.saved)).toBeVisible();

    await expect.poll(() => savedTrashDays(admin)).toBe(days);
    await page.reload();
    await expect(await trashDays(page)).toHaveValue(String(days));
  });

  // FL-71: "Reset this page" puts the page's defaults into the draft for review; saving writes the defaults.
  test('reset this page loads the defaults into the draft and saving writes them', async ({ page }) => {
    const defaults = await getConfigDefaults({ headers: asBearerAuth(admin.accessToken) });
    const savedDays = defaults.trash.days + 15;
    await setTrashDays(admin, savedDays);

    await page.goto(trashUrl);
    const field = await trashDays(page);
    await expect(field).toHaveValue(String(savedDays));
    await field.fill(String(savedDays + 5));

    await page.getByRole('button', { name: labels.resetPage }).click();
    await expect(page.getByText(labels.defaultsRestored)).toBeVisible();
    await expect(field).toHaveValue(String(defaults.trash.days));
    // The defaults are only in the draft until saved.
    expect(await savedTrashDays(admin)).toBe(savedDays);

    await reviewAndSave(page);
    await expect.poll(() => savedTrashDays(admin)).toBe(defaults.trash.days);
  });

  // FL-71: Discard in the settings bar returns every page to the saved settings; nothing is written.
  test('discard returns the page to the saved settings', async ({ page }) => {
    const before = await readConfig(admin);

    await page.goto(trashUrl);
    const field = await trashDays(page);
    await field.fill(String(before.trash.days + 7));

    const bar = page.getByRole('region', { name: labels.bar });
    await bar.getByRole('button', { name: labels.discard, exact: true }).click();

    await expect(page.getByText(labels.discarded)).toBeVisible();
    await expect(bar).toBeHidden();
    await expect(field).toHaveValue(String(before.trash.days));
    expect(await savedTrashDays(admin)).toBe(before.trash.days);
  });

  // FL-71 / FL-67: the export writes frameleaf-settings.json without any credential value.
  test('export downloads frameleaf-settings.json without credentials', async ({ page }) => {
    const config = await readConfig(admin);
    await updateConfig(
      {
        adminConfigDto: {
          ...config,
          oauth: { ...config.oauth, clientSecret: 'e2e-oauth-client-secret' },
          notifications: {
            ...config.notifications,
            smtp: {
              ...config.notifications.smtp,
              enabled: false,
              transport: { ...config.notifications.smtp.transport, password: 'e2e-smtp-password' },
            },
          },
        },
      },
      { headers: asBearerAuth(admin.accessToken) },
    );

    await page.goto(configurationUrl);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: labels.exportSettings }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('frameleaf-settings.json');

    const path = await download.path();
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('e2e-oauth-client-secret');
    expect(text).not.toContain('e2e-smtp-password');

    const exported = JSON.parse(text);
    expect(exported.oauth?.clientSecret ?? '').toBe('');
    expect(exported.notifications?.smtp?.transport?.password ?? '').toBe('');
    expect(exported.trash.days).toBe(config.trash.days);
  });

  // FL-71: an imported file lands in the draft for review; nothing is applied until it is saved.
  test('import loads a settings file into the draft until it is saved', async ({ page }) => {
    const before = await readConfig(admin);
    const days = before.trash.days + 11;

    await page.goto(configurationUrl);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: labels.importSettings }).click(),
    ]);
    await chooser.setFiles({
      name: 'frameleaf-settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ trash: { days } })),
    });

    await expect(page.getByText(labels.importedOne)).toBeVisible();
    await expect(page.getByRole('region', { name: labels.bar })).toBeVisible();
    // Loaded into the draft, not applied.
    expect(await savedTrashDays(admin)).toBe(before.trash.days);

    await reviewAndSave(page);
    await expect.poll(() => savedTrashDays(admin)).toBe(days);
  });

  // FL-71 (owner decision 2026-09-27): how often to look is a real setting, saved through the
  // settings bar and carried by export and import. FL-368 shows it as "Look for updates:
  // Never / Every day / Every week".
  test('saves the update-check frequency, exports it and imports it back', async ({ page }) => {
    const before = await readConfig(admin);
    expect(before.newVersionCheck.frequency).toBe('daily');

    await page.goto(versionCheckUrl);
    // A server that is not looking shows "Never", whatever frequency is saved.
    await expect(lookChoice(page, before.newVersionCheck.enabled ? labels.daily : labels.never)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('group', { name: labels.lookForUpdates }).getByRole('button')).toHaveText([
      labels.never,
      labels.daily,
      labels.weekly,
    ]);
    await lookChoice(page, labels.weekly).click();
    const unsaved = await readConfig(admin);
    expect(unsaved.newVersionCheck.frequency).toBe('daily');

    await reviewAndSave(page);
    await expect
      .poll(async () => {
        const config = await readConfig(admin);
        return config.newVersionCheck.frequency;
      })
      .toBe('weekly');
    await page.reload();
    await expect(lookChoice(page, labels.weekly)).toHaveAttribute('aria-pressed', 'true');

    await page.goto(configurationUrl);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: labels.exportSettings }).click(),
    ]);
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    expect(exported.newVersionCheck.frequency).toBe('weekly');

    await updateConfig(
      {
        adminConfigDto: {
          ...before,
          newVersionCheck: { ...before.newVersionCheck, frequency: VersionCheckFrequency.Daily },
        },
      },
      { headers: asBearerAuth(admin.accessToken) },
    );
    await page.reload();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: labels.importSettings }).click(),
    ]);
    await chooser.setFiles({
      name: 'frameleaf-settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ newVersionCheck: { frequency: 'weekly' } })),
    });
    await expect(page.getByText(labels.importedOne)).toBeVisible();
    await reviewAndSave(page);
    await expect
      .poll(async () => {
        const config = await readConfig(admin);
        return config.newVersionCheck.frequency;
      })
      .toBe('weekly');
  });

  // FL-71, ADMIN-P3: an email's wording opens with a preview in sample names and never claims an
  // email was sent.
  test('email wording preview shows the email with sample names without sending', async ({ page }) => {
    await page.goto(notificationsUrl);
    await page.getByText(labels.changeWording, { exact: true }).click();
    await page.getByRole('button', { name: labels.editWelcome }).click();

    const dialog = page.getByRole('dialog', { name: labels.welcome });
    await expect(dialog).toBeVisible();
    const preview = dialog.getByRole('group', { name: labels.preview });
    // frameleaf_notify_wording_welcome_standard, with the sample person's name
    await expect(preview).toContainText('Hey Morgan!');
    await expect(preview).toContainText('A new account has been created for you.');

    await expect(preview.getByText(/\bsent\b/i)).toHaveCount(0);
    // admin.notification_email_test_email_sent
    await expect(page.getByText(/test email has been sent/i)).toHaveCount(0);
  });

  // FL-379: this server is not linked to a Frameleaf account, so signing in with Google or Microsoft
  // is explained, never offered, and the server refuses to start one. Gmail keeps its app password.
  test('email delivery says why sign-in needs a linked server and refuses to start one', async ({ page }) => {
    await page.goto(notificationsUrl);
    const providers = page.getByRole('group', { name: 'Which email should Frameleaf send from?' });

    for (const [tile, who] of [
      [/^Gmail/, 'Google'],
      [/^Microsoft/, 'Microsoft'],
    ] as const) {
      await providers.getByRole('button', { name: tile }).click();
      await expect(page.getByText(`Signing in with ${who} needs a Frameleaf account`)).toBeVisible();
      await expect(page.getByRole('button', { name: `Sign in with ${who}`, exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Link this server' })).toBeVisible();
    }

    await providers.getByRole('button', { name: /^Gmail/ }).click();
    await page.getByRole('button', { name: 'Use an app password instead' }).click();
    await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();

    const headers = { Authorization: `Bearer ${admin.accessToken}` };
    const state = await page.request.get('/api/admin/notifications/mail-connection', { headers });
    expect(await state.json()).toMatchObject({ available: false, providers: [], connection: null, signIn: 'none' });
    const start = await page.request.post('/api/admin/notifications/mail-connection/start', {
      headers,
      data: { provider: 'gmail' },
    });
    expect(start.status()).toBe(400);
  });

  // FL-71 (FL-66): a save in one tab makes another tab's overlapping draft stale, with the conflict banner.
  test('another tab with an overlapping draft shows the stale banner after a save', async ({ context, page }) => {
    const before = await readConfig(admin);
    const other = await context.newPage();

    await page.goto(trashUrl);
    await other.goto(trashUrl);
    await expect(await trashDays(other)).toHaveValue(String(before.trash.days));
    await fillTrashDays(other, String(before.trash.days + 3));
    await expect(other.getByRole('region', { name: labels.bar })).toBeVisible();

    await fillTrashDays(page, String(before.trash.days + 9));
    await reviewAndSave(page);

    const banner = other.getByRole('alert').filter({ hasText: labels.conflict });
    await expect(banner).toBeVisible();
    await expect(
      other.getByRole('region', { name: labels.bar }).getByRole('button', { name: labels.review }),
    ).toBeDisabled();
    await other.close();
  });

  test('recovers a two-page draft, reviews a second-admin conflict, and resets only one page', async ({
    browser,
    page,
  }) => {
    const defaults = await getConfigDefaults({ headers: asBearerAuth(admin.accessToken) });
    const savedDays = defaults.trash.days + 15;
    await setTrashDays(admin, savedDays);
    const before = await readConfig(admin);
    const draftDays = savedDays + 5;
    const otherDays = savedDays + 9;
    const frequency =
      before.newVersionCheck.frequency === VersionCheckFrequency.Daily
        ? VersionCheckFrequency.Weekly
        : VersionCheckFrequency.Daily;

    await page.goto(trashUrl);
    await fillTrashDays(page, String(draftDays));
    const navigation = page.getByRole('navigation', { name: 'Settings navigation' });
    // Server & updates opens on its own landing page (FL-368); its pages are listed there.
    await navigation.getByRole('button', { name: 'Server & updates' }).click();
    await page.getByRole('button', { name: labels.updates, exact: true }).click();
    await lookChoice(page, frequencyLabel[frequency]).click();
    const bar = page.getByRole('region', { name: labels.bar });
    await expect(bar).toBeVisible();

    // A different account saves in an isolated browser while both draft pages remain unsaved.
    const secondAdmin = await utils.userSetup(admin.accessToken, {
      email: 'second-admin@example.com',
      name: 'Second administrator',
      password: 'password',
      isAdmin: true,
    });
    const otherContext = await browser.newContext({ baseURL: baseUrl });
    try {
      await utils.setAuthCookies(otherContext, secondAdmin.accessToken);
      const otherPage = await otherContext.newPage();
      await otherPage.goto(trashUrl);
      await expect(await trashDays(otherPage)).toHaveValue(String(savedDays));
      await fillTrashDays(otherPage, String(otherDays));
      await reviewAndSave(otherPage);
      await expect.poll(() => savedTrashDays(admin)).toBe(otherDays);
    } finally {
      await otherContext.close();
    }
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    // Trash days and the frequency; choosing a frequency on a server that was not looking also turns looking on.
    const pending = before.newVersionCheck.enabled ? 2 : 3;
    await expect(page.getByText(`Recovered ${pending} unsaved changes from before the page reloaded.`)).toBeVisible();
    await expect(lookChoice(page, frequencyLabel[frequency])).toHaveAttribute('aria-pressed', 'true');
    const conflict = page.getByRole('alert').filter({ hasText: labels.conflict });
    await expect(conflict).toBeVisible();
    await expect(conflict.getByText(`Saved now: ${otherDays}`)).toBeVisible();
    await expect(conflict.getByText(`Your draft: ${draftDays}`)).toBeVisible();
    await expect(bar.getByRole('button', { name: labels.review })).toBeDisabled();

    await navigation.getByRole('button', { name: 'Storage & originals' }).click();
    await page.getByRole('link', { name: /Deleted items/ }).click();
    const days = await trashDays(page);
    await expect(days).toHaveValue(String(draftDays));
    await conflict.getByRole('button', { name: 'Keep my changes' }).click();
    await expect(conflict).toBeHidden();
    await expect(days).toHaveValue(String(draftDays));
    await page.getByRole('button', { name: labels.resetPage }).click();
    await expect(days).toHaveValue(String(defaults.trash.days));
    await expect(bar).toBeVisible();

    await reviewAndSave(page);
    await expect
      .poll(async () => {
        const config = await readConfig(admin);
        return { days: config.trash.days, frequency: config.newVersionCheck.frequency };
      })
      .toEqual({ days: defaults.trash.days, frequency });
  });
});
