<script lang="ts">
  /**
   * "Set up your account" (FL-176): the prototype's `AccountSetupTool`
   * (`design/frameleaf/template/src/FirstRunSetup.jsx`) in place of the per-account onboarding
   * wizard. A one-time page of independent sections — link your Frameleaf account (FL-158's
   * `FrameleafAccountSection`), profile, appearance, privacy and notifications, and the mobile app —
   * done in any order. Done marks the account onboarded; the account menu reopens it.
   */
  import { goto } from '$app/navigation';
  import logoDarkUrl from '$lib/assets/frameleaf/frameleaf-logo-dark.svg?url';
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import FrameleafAccountSection from '$lib/components/frameleaf/access/FrameleafAccountSection.svelte';
  import AvatarEditorDialog from '$lib/components/frameleaf/AvatarEditorDialog.svelte';
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import SetupSwitch from '$lib/components/frameleaf/setup/SetupSwitch.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    accountToolProgress,
    accountToolSections,
    loadAccountTool,
    markSection,
    saveAccountTool,
    SETUP_THEME,
    type AccountSectionId,
  } from '$lib/frameleaf/first-run-setup';
  import '$lib/frameleaf/auth.css';
  import '$lib/frameleaf/first-run-setup.css';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { lang } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { convertBCP47, langs } from '$lib/utils/i18n';
  import { getFrameleafAccountLink, setUserOnboarding, updateMyPreferences, updateMyUser } from '@immich/sdk';
  import { Icon, modalManager, themeManager, ThemePreference } from '@immich/ui';
  import {
    mdiAccountCircleOutline,
    mdiCellphone,
    mdiCheck,
    mdiCloudOutline,
    mdiMoonWaningCrescent,
    mdiPaletteOutline,
    mdiShieldAccountOutline,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale as i18nLocale, t } from 'svelte-i18n';

  const user = authManager.user;
  const preferences = authManager.preferences;
  let tool = $state(loadAccountTool(user.id));
  let name = $state(user.name);
  let theme = $state<'dark' | 'light'>(themeManager.value === 'light' ? 'light' : 'dark');
  // The saved language may be a regional tag (en-US) the language files don't have; match its base.
  const codes = langs.map((entry) => convertBCP47(entry.code));
  let language = $state(
    codes.find((code) => code === $lang) ?? codes.find((code) => code === $lang.split('-')[0]) ?? 'en',
  );
  let albums = $state(preferences.emailNotifications.albumUpdate);
  let email = $state(preferences.emailNotifications.enabled);
  let memories = $state(preferences.memories.enabled);
  let error = $state('');
  let finishing = $state(false);

  const icons: Record<AccountSectionId, string> = {
    profile: mdiAccountCircleOutline,
    appearance: mdiPaletteOutline,
    privacy: mdiShieldAccountOutline,
    mobile: mdiCellphone,
    frameleaf: mdiCloudOutline,
  };
  const progress = $derived(accountToolProgress(tool));
  const isDone = (id: AccountSectionId) => tool.done.includes(id);
  const done = (id: AccountSectionId) => {
    tool = markSection(tool, id);
    saveAccountTool(user.id, tool);
  };

  onMount(async () => {
    try {
      const link = await getFrameleafAccountLink();
      if (link.linked) {
        done('frameleaf');
      }
    } catch {
      // the section itself says when the link can't be read
    }
  });

  const save = async (id: AccountSectionId, call: () => Promise<unknown>) => {
    error = '';
    try {
      await call();
      done(id);
    } catch (error_) {
      error = getServerErrorMessage(error_) || $t('frameleaf_setup_error_generic');
    }
  };

  const saveProfile = () =>
    save('profile', async () => {
      if (name.trim() && name.trim() !== user.name) {
        await updateMyUser({ userUpdateMeDto: { name: name.trim() } });
        await authManager.load();
      }
    });
  const saveAppearance = () =>
    save('appearance', async () => {
      $lang = language;
      await i18nLocale.set(convertBCP47(language));
    });
  const savePrivacy = () =>
    save('privacy', () =>
      updateMyPreferences({
        userPreferencesUpdateDto: {
          emailNotifications: { albumUpdate: albums, enabled: email },
          memories: { enabled: memories },
        },
      }),
    );

  const finish = async () => {
    finishing = true;
    error = '';
    try {
      await setUserOnboarding({ onboardingDto: { isOnboarded: true } });
      saveAccountTool(user.id, { ...tool });
      // The theme choice applies when this page closes; setup itself is always dark.
      themeManager.setPreference(theme === 'light' ? ThemePreference.Light : ThemePreference.Dark);
      await goto(Route.photos(), { invalidateAll: true });
    } catch (error_) {
      error = getServerErrorMessage(error_) || $t('frameleaf_setup_error_generic');
    } finally {
      finishing = false;
    }
  };
</script>

{#snippet section(id: AccountSectionId, body: import('svelte').Snippet, action: string, onsave: () => void)}
  <section class="frs-tool-card" class:done={isDone(id)} aria-labelledby="frs-tool-{id}" data-section={id}>
    <header>
      <Icon icon={icons[id]} size="20" aria-hidden={true} />
      <h2 id="frs-tool-{id}">{$t(accountToolSections.find((entry) => entry.id === id)!.title)}</h2>
      {#if isDone(id)}
        <span class="frs-done-chip"
          ><Icon icon={mdiCheck} size="12" aria-hidden={true} /> {$t('frameleaf_setup_tool_done')}</span
        >
      {/if}
    </header>
    <div class="frs-tool-body">{@render body()}</div>
    <footer>
      <button type="button" class="button" onclick={onsave} disabled={isDone(id)}>
        {isDone(id) ? $t('frameleaf_setup_tool_saved') : action}
      </button>
    </footer>
  </section>
{/snippet}

{#snippet profile()}
  <div class="frs-avatars">
    <UserAvatar {user} size="lg" />
    <button type="button" class="auth-link" onclick={() => void modalManager.show(AvatarEditorDialog, {})}>
      {$t('edit_avatar')}
    </button>
  </div>
  <div class="auth-field">
    <label for="frs-profile-name">{$t('frameleaf_setup_tool_display_name')}</label>
    <input id="frs-profile-name" autocomplete="name" bind:value={name} />
  </div>
{/snippet}

{#snippet appearance()}
  <div class="frs-theme" role="radiogroup" aria-label={$t('theme')}>
    <span>{$t('theme')}</span>
    {#each [['dark', 'dark', mdiMoonWaningCrescent], ['light', 'light', mdiWhiteBalanceSunny]] as const as [value, label, icon] (value)}
      <label class:checked={theme === value}>
        <input type="radio" name="frs-tool-theme" checked={theme === value} onchange={() => (theme = value)} />
        <Icon {icon} size="16" aria-hidden={true} />{$t(label)}
      </label>
    {/each}
  </div>
  <p class="auth-note">{$t('frameleaf_setup_tool_theme_note')}</p>
  <div class="auth-field">
    <label for="frs-tool-language">{$t('language')}</label>
    <select id="frs-tool-language" bind:value={language}>
      {#each langs as entry (entry.code)}
        <option value={convertBCP47(entry.code)}>{entry.name}</option>
      {/each}
    </select>
  </div>
{/snippet}

{#snippet privacy()}
  <div class="frs-switches compact">
    <SetupSwitch
      label={$t('frameleaf_setup_tool_albums')}
      description={$t('frameleaf_setup_tool_albums_body')}
      checked={albums}
      onchange={(value) => (albums = value)}
    />
    <SetupSwitch
      label={$t('frameleaf_setup_tool_memories')}
      description={$t('frameleaf_setup_tool_memories_body')}
      checked={memories}
      onchange={(value) => (memories = value)}
    />
    <SetupSwitch
      label={$t('frameleaf_setup_tool_email')}
      description={$t('frameleaf_setup_tool_email_body')}
      checked={email}
      onchange={(value) => (email = value)}
    />
  </div>
{/snippet}

{#snippet mobile()}
  <div class="frs-mobile">
    <QrCode
      value={globalThis.location?.origin ?? ''}
      size={132}
      label={$t('frameleaf_setup_tool_qr')}
      copyLabel={$t('copy_link')}
      downloadLabel={$t('download')}
      errorLabel={$t('frameleaf_setup_error_generic')}
      showActions={false}
    />
    <div>
      <strong>{$t('frameleaf_setup_tool_mobile_title')}</strong>
      <span>{$t('frameleaf_setup_tool_mobile_body')}</span>
    </div>
  </div>
{/snippet}

<section class="frameleaf auth-screen frs-tool-root" data-theme={SETUP_THEME}>
  <div class="frs frs-tool-screen">
    <div class="frs-tool">
      <header class="frs-tool-head">
        <img src={logoDarkUrl} alt="Frameleaf" />
        <div>
          <h1>{$t('frameleaf_setup_tool_title')}</h1>
          <p>{$t('frameleaf_setup_tool_lead')}</p>
        </div>
        <div
          class="frs-tool-progress"
          aria-label={$t('frameleaf_setup_tool_progress', { values: { done: progress.done, total: progress.total } })}
        >
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r="15.5" />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              pathLength="1"
              style:stroke-dashoffset={1 - progress.done / progress.total}
            />
          </svg>
          <span>{progress.done}/{progress.total}</span>
        </div>
      </header>

      <section class="frs-link-card" class:linked={isDone('frameleaf')} aria-labelledby="frs-tool-frameleaf">
        <div class="frs-link-art" aria-hidden="true"><img src={symbolUrl} alt="" /></div>
        <div class="frs-link-copy">
          <span class="frs-eyebrow">{$t('frameleaf_setup_recommended')}</span>
          <h2 id="frs-tool-frameleaf">{$t('frameleaf_setup_tool_link_title')}</h2>
          <ul class="frs-ticks">
            <li>{$t('frameleaf_setup_tool_link_anywhere')}</li>
            <li>{$t('frameleaf_setup_tool_link_badge')}</li>
            <li>{$t('frameleaf_setup_tool_link_cloud')}</li>
          </ul>
          <small>{$t('frameleaf_setup_tool_link_note')}</small>
        </div>
        <div class="frs-link-action"><FrameleafAccountSection /></div>
      </section>

      {#if error}<p class="auth-error" role="alert">{error}</p>{/if}

      <div class="frs-tool-grid">
        {@render section('profile', profile, $t('save'), () => void saveProfile())}
        {@render section('appearance', appearance, $t('save'), () => void saveAppearance())}
        {@render section('privacy', privacy, $t('save'), () => void savePrivacy())}
        {@render section('mobile', mobile, $t('frameleaf_setup_tool_got_app'), () => done('mobile'))}
      </div>

      <footer class="frs-tool-foot">
        <span class="auth-note">{$t('frameleaf_setup_tool_reopen')}</span>
        <a class="auth-link" href={Route.logout()}>{$t('frameleaf_setup_sign_out')}</a>
        <button type="button" class="button primary" disabled={finishing} onclick={() => void finish()}>
          {$t('done')}
        </button>
      </footer>
    </div>
  </div>
</section>

<style>
  .frs-tool-root {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--fl-canvas);
    color-scheme: dark;
  }
</style>
