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
  trashDays: 'Number of days', // admin.trash_number_of_days
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
  exportSettings: 'Export settings', // frameleaf_cc_config_export
  importSettings: 'Import settings', // frameleaf_cc_config_import
  emailTemplates: 'Email Templates', // admin.template_email_settings
  preview: 'Preview', // admin.template_email_preview
  checkFrequency: 'Check frequency', // frameleaf_versions_frequency_title
};

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
    const field = page.getByLabel(labels.trashDays);
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
    await expect(page.getByLabel(labels.trashDays)).toHaveValue(String(days));
  });

  // FL-71: "Reset this page" puts the page's defaults into the draft for review; saving writes the defaults.
  test('reset this page loads the defaults into the draft and saving writes them', async ({ page }) => {
    const defaults = await getConfigDefaults({ headers: asBearerAuth(admin.accessToken) });
    const savedDays = defaults.trash.days + 15;
    await setTrashDays(admin, savedDays);

    await page.goto(trashUrl);
    const field = page.getByLabel(labels.trashDays);
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
    const field = page.getByLabel(labels.trashDays);
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

  // FL-71 (owner decision 2026-09-27): "Check frequency" is a real setting with the prototype's
  // Daily and Weekly, saved through the settings bar and carried by export and import.
  test('saves the update-check frequency, exports it and imports it back', async ({ page }) => {
    const before = await readConfig(admin);
    expect(before.newVersionCheck.frequency).toBe('daily');

    await page.goto(versionCheckUrl);
    const select = page.getByRole('combobox', { name: labels.checkFrequency });
    await expect(select).toHaveValue('daily');
    await expect(select.locator('option')).toHaveText(['Daily', 'Weekly']);
    await select.selectOption('weekly');
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
    await expect(page.getByRole('combobox', { name: labels.checkFrequency })).toHaveValue('weekly');

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

  // FL-71: an email template preview shows the rendered template and never claims an email was sent.
  test('email template preview shows the rendered template without sending', async ({ page }) => {
    await page.goto(notificationsUrl);
    await page.getByRole('button', { name: labels.emailTemplates }).click();
    await page.getByRole('button', { name: labels.preview }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const frame = dialog.frameLocator(`iframe[title="${labels.preview}"]`);
    // server/src/emails/welcome.email.tsx, the default welcome template.
    await expect(frame.getByText('A new account has been created for you.')).toBeVisible();

    await expect(dialog.getByText(/\bsent\b/i)).toHaveCount(0);
    // admin.notification_email_test_email_sent
    await expect(page.getByText(/test email has been sent/i)).toHaveCount(0);
  });

  // FL-71 (FL-66): a save in one tab makes another tab's overlapping draft stale, with the conflict banner.
  test('another tab with an overlapping draft shows the stale banner after a save', async ({ context, page }) => {
    const before = await readConfig(admin);
    const other = await context.newPage();

    await page.goto(trashUrl);
    await other.goto(trashUrl);
    await expect(other.getByLabel(labels.trashDays)).toHaveValue(String(before.trash.days));
    await other.getByLabel(labels.trashDays).fill(String(before.trash.days + 3));
    await expect(other.getByRole('region', { name: labels.bar })).toBeVisible();

    await page.getByLabel(labels.trashDays).fill(String(before.trash.days + 9));
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
    await page.getByLabel(labels.trashDays).fill(String(draftDays));
    const navigation = page.getByRole('navigation', { name: 'Settings navigation' });
    await navigation.getByRole('button', { name: 'Server & updates' }).click();
    await navigation.getByRole('button', { name: 'Versions & compatibility' }).click();
    await page.getByRole('combobox', { name: labels.checkFrequency }).selectOption(frequency);
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
      await expect(otherPage.getByLabel(labels.trashDays)).toHaveValue(String(savedDays));
      await otherPage.getByLabel(labels.trashDays).fill(String(otherDays));
      await reviewAndSave(otherPage);
      await expect.poll(() => savedTrashDays(admin)).toBe(otherDays);
    } finally {
      await otherContext.close();
    }
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByText('Recovered 2 unsaved changes from before the page reloaded.')).toBeVisible();
    await expect(page.getByRole('combobox', { name: labels.checkFrequency })).toHaveValue(frequency);
    const conflict = page.getByRole('alert').filter({ hasText: labels.conflict });
    await expect(conflict).toBeVisible();
    await expect(conflict.getByText(`Saved now: ${otherDays}`)).toBeVisible();
    await expect(conflict.getByText(`Your draft: ${draftDays}`)).toBeVisible();
    await expect(bar.getByRole('button', { name: labels.review })).toBeDisabled();

    await navigation.getByRole('button', { name: 'Storage & originals' }).click();
    await navigation.getByRole('button', { name: 'Trash & retention' }).click();
    const days = page.getByLabel(labels.trashDays);
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
