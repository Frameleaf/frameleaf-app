<script lang="ts">
  import { page } from '$app/state';
  import { clickOutside } from '$lib/actions/click-outside';
  import { focusTrap } from '$lib/actions/focus-trap';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AvatarEditorDialog from '$lib/components/frameleaf/AvatarEditorDialog.svelte';
  import AboutDialog from '$lib/components/frameleaf/AboutDialog.svelte';
  import HelpFeedbackDialog from '$lib/components/frameleaf/HelpFeedbackDialog.svelte';
  import { Route } from '$lib/route';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { formatUsd } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getAboutInfo, getCloudMlStatus, getCloudStatus, getVersionHistory } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiAccountCheckOutline,
    mdiAccountEditOutline,
    mdiChevronDown,
    mdiChevronRight,
    mdiCloudOutline,
    mdiCogOutline,
    mdiHandHeartOutline,
    mdiInformationOutline,
    mdiLifebuoy,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiLogoutVariant,
    mdiShieldAccountOutline,
    mdiShieldLockOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf account menu (FL-30), ported from `SystemPanels.jsx`.
   *
   * Carries the identity, the Locked session controls, account settings,
   * administration for an administrator, the avatar editor, support and sign out.
   * The Locked state is owned by the top bar so the menu and the top bar's Locked icon
   * can never disagree.
   */

  interface Props {
    isElevated: boolean;
    isSessionLoading: boolean;
    onUnlock: () => void;
    onLock: () => void;
  }

  let { isElevated, isSessionLoading, onUnlock, onLock }: Props = $props();

  let open = $state(false);
  let menu = $state<HTMLDivElement>();

  /**
   * FL-157 (SystemPanels.jsx:738-761): the Frameleaf Cloud row shows the link state and, for an
   * administrator of a linked server, the AI credit the server last read. Read when the menu opens.
   */
  let cloud = $state<{ linked: boolean; account: string | null; creditUsd: number | null } | null>(null);
  const cloudConfigured = $derived(authManager.user.isAdmin || featureFlagsManager.value.frameleafCloud);

  const loadCloud = async () => {
    if (!authManager.user.isAdmin) {
      cloud = { linked: featureFlagsManager.value.frameleafCloud, account: null, creditUsd: null };
      return;
    }
    try {
      const status = await getCloudStatus();
      const linked = status.state === 'linked';
      const wallet = linked ? ((await getCloudMlStatus().catch(() => null))?.wallet ?? null) : null;
      cloud = { linked, account: status.account?.label ?? null, creditUsd: wallet?.availableUsd ?? null };
    } catch {
      cloud = null;
    }
  };

  $effect(() => {
    if (open) {
      void loadCloud();
    }
  });

  // S-5 (SystemPanels.jsx:677-686): the Supporter badge shows for a supporter who has not hidden it.
  const showSupporter = $derived(
    authManager.isPurchased && authManager.authenticated && authManager.preferences.purchase.showSupportBadge,
  );

  const close = () => (open = false);
  const run = (action: () => void) => {
    close();
    action();
  };

  const items = () =>
    menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')] : [];

  const onMenuKeydown = (event: KeyboardEvent) => {
    const focusable = items();
    if (focusable.length === 0) {
      return;
    }

    const index = focusable.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        focusable[(index + 1) % focusable.length].focus();
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        focusable[(index <= 0 ? focusable.length : index) - 1].focus();
        break;
      }
      case 'Home': {
        event.preventDefault();
        focusable[0].focus();
        break;
      }
      case 'End': {
        event.preventDefault();
        focusable.at(-1)?.focus();
        break;
      }
    }
  };

  const openAvatarEditor = async () => {
    close();
    await modalManager.show(AvatarEditorDialog, {});
  };

  const openSupport = async () => {
    close();
    const info = userInteraction.aboutInfo ?? (await getAboutInfo());
    await modalManager.show(HelpFeedbackDialog, { info });
  };

  const openAbout = async () => {
    close();
    const [info, versions] = await Promise.all([
      userInteraction.aboutInfo ?? getAboutInfo(),
      userInteraction.versions ?? getVersionHistory(),
    ]);
    userInteraction.aboutInfo = info;
    userInteraction.versions = versions;
    await modalManager.show(AboutDialog, { info, versions });
  };
</script>

<div class="fl-account" use:clickOutside={{ onOutclick: close, onEscape: close }}>
  <button
    type="button"
    class="fl-account-button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$t('frameleaf_account_menu_for', { values: { name: authManager.user.name } })}
    onclick={() => (open = !open)}
  >
    {#key authManager.user}
      <UserAvatar user={authManager.user} size="md" noTitle interactive />
    {/key}
    <span class="fl-account-name">{authManager.user.name}</span>
    <Icon icon={mdiChevronDown} size="1em" aria-hidden={true} />
  </button>

  {#if open}
    <div
      bind:this={menu}
      class="fl-menu"
      role="menu"
      tabindex="-1"
      aria-label={$t('account_settings')}
      onkeydown={onMenuKeydown}
      use:focusTrap
    >
      <div class="fl-identity">
        <UserAvatar user={authManager.user} size="lg" noTitle />
        <div>
          <strong>
            {authManager.user.name}
            {#if authManager.user.isAdmin}<span class="account-tag">{$t('frameleaf_account_admin_tag')}</span>{/if}
            {#if showSupporter}
              <span class="supporter-badge">
                <Icon icon={mdiHandHeartOutline} size="12" aria-hidden={true} />
                {$t('supporter')}
              </span>
            {/if}
          </strong>
          <span>{authManager.user.email}</span>
        </div>
      </div>
      <hr />

      <button
        type="button"
        role="menuitemcheckbox"
        class="fl-item"
        aria-checked={isElevated}
        disabled={isSessionLoading}
        onclick={() => run(isElevated ? onLock : onUnlock)}
      >
        <Icon icon={isElevated ? mdiLockOpenVariantOutline : mdiLockOutline} size="1.125em" aria-hidden={true} />
        <span>
          {$t('frameleaf_locked_content')}
          <small>{isElevated ? $t('frameleaf_locked_revealed') : $t('frameleaf_locked_hidden')}</small>
        </span>
        <!-- S-24 (SystemPanels.jsx:77-88, system.css:379-393): the item carries a switch affordance. -->
        <span class="fl-switch" aria-hidden="true"></span>
      </button>

      <a href={Route.locked()} role="menuitem" class="fl-item" onclick={close}>
        <Icon icon={mdiShieldLockOutline} size="1.125em" aria-hidden={true} />
        <span>
          {$t('frameleaf_open_locked')}
          {#if !isElevated}<small>{$t('frameleaf_open_locked_hint')}</small>{/if}
        </span>
        <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} />
      </a>

      <hr />

      {#if cloudConfigured}
        <a
          href={authManager.user.isAdmin
            ? commandCenterUrl('cloud', 'cloud-account')
            : commandCenterUrl('preferences', 'frameleaf-account')}
          role="menuitem"
          class="fl-item"
          onclick={close}
        >
          <Icon icon={mdiCloudOutline} size="1.125em" aria-hidden={true} />
          <span>
            {$t('frameleaf_settings_area_cloud')}
            <small>
              {cloud?.linked
                ? cloud.account
                  ? $t('frameleaf_account_menu_cloud_linked_to', { values: { account: cloud.account } })
                  : $t('frameleaf_account_menu_cloud_linked')
                : $t('frameleaf_account_menu_cloud_not_linked')}
            </small>
          </span>
          {#if cloud?.creditUsd !== null && cloud?.creditUsd !== undefined}
            <span class="cloud-pill" title={$t('frameleaf_account_menu_cloud_credit')}>
              {formatUsd(cloud.creditUsd, 2)}
            </span>
          {/if}
        </a>
      {/if}

      <a href={Route.buy()} role="menuitem" class="fl-item" onclick={close}>
        <Icon icon={mdiHandHeartOutline} size="1.125em" aria-hidden={true} />
        <span>
          {$t('buy')}
          <small>{$t('frameleaf_account_menu_support_hint')}</small>
        </span>
      </a>

      <hr />

      <a href={Route.userSettings()} role="menuitem" class="fl-item" onclick={close}>
        <Icon icon={mdiCogOutline} size="1.125em" aria-hidden={true} />
        <span>{$t('account_settings')}</span>
      </a>

      {#if authManager.user.isAdmin}
        <a
          href={Route.systemSettings()}
          role="menuitem"
          class="fl-item"
          aria-current={page.url.pathname.startsWith('/admin') ? 'page' : undefined}
          onclick={close}
        >
          <Icon icon={mdiShieldAccountOutline} size="1.125em" aria-hidden={true} />
          <span>{$t('administration')}</span>
        </a>
      {/if}

      <button type="button" role="menuitem" class="fl-item" onclick={() => void openAvatarEditor()}>
        <Icon icon={mdiAccountEditOutline} size="1.125em" aria-hidden={true} />
        <span>{$t('edit_avatar')}</span>
      </button>

      <!-- FL-176: the one-time "Set up your account" page can be reopened from here. -->
      <a href={Route.onboarding()} role="menuitem" class="fl-item" onclick={close}>
        <Icon icon={mdiAccountCheckOutline} size="1.125em" aria-hidden={true} />
        <span>{$t('frameleaf_setup_tool_title')}</span>
      </a>

      <hr />

      <button type="button" role="menuitem" class="fl-item" onclick={() => void openSupport()}>
        <Icon icon={mdiLifebuoy} size="1.125em" aria-hidden={true} />
        <span>{$t('support_and_feedback')}</span>
      </button>

      <button type="button" role="menuitem" class="fl-item" onclick={() => void openAbout()}>
        <Icon icon={mdiInformationOutline} size="1.125em" aria-hidden={true} />
        <span>{$t('frameleaf_about_menu_item')}</span>
      </button>

      <hr />

      <!-- S-23 (SystemPanels.jsx:132-135, system.css:375-378): Sign out is the danger item. -->
      <a href={Route.logout()} role="menuitem" class="fl-item danger" onclick={close}>
        <Icon icon={mdiLogoutVariant} size="1.125em" aria-hidden={true} />
        <span>{$t('sign_out')}</span>
      </a>
    </div>
  {/if}
</div>

<style>
  .fl-account {
    position: relative;
  }
  .cloud-pill {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-accent-soft, var(--fl-raised));
    color: var(--fl-accent);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .fl-account-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
  }
  .fl-account-button:hover {
    background: var(--fl-raised);
  }
  .fl-account-name {
    display: none;
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-menu {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + 0.5rem);
    z-index: 30;
    display: flex;
    width: min(20rem, calc(100vw - 2rem));
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    background: var(--fl-panel);
    box-shadow: 0 12px 32px rgb(0 0 0 / 35%);
  }
  .fl-identity {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
  }
  .fl-identity div {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .fl-identity > div > span {
    color: var(--fl-muted);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fl-identity strong {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  /* design/frameleaf/template/src/system.css `.account-tag`, auth.css `.supporter-badge`. */
  .account-tag {
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-muted);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    padding: 0 7px;
    line-height: 16px;
  }
  .supporter-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-accent);
    background: var(--fl-accent-soft);
    border-radius: var(--fl-radius-pill);
    padding: 2px 8px;
  }
  hr {
    margin: 0.25rem 0;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
  .fl-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5rem;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    text-align: start;
    text-decoration: none;
    font-size: 0.875rem;
  }
  .fl-item:hover:not(:disabled) {
    background: var(--fl-raised);
  }
  .fl-item:disabled {
    color: var(--fl-muted);
    cursor: default;
  }
  .fl-item > span:not(.fl-switch) {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
  }
  .fl-item.danger,
  .fl-item.danger :global(svg) {
    color: var(--fl-danger);
  }
  /* system.css `.fl-switch` at the menu size (34 × 20, 14px knob). */
  .fl-switch {
    position: relative;
    flex-shrink: 0;
    width: 34px;
    height: 20px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-border);
    transition: background var(--fl-motion) var(--fl-ease);
  }
  .fl-switch::after {
    content: '';
    position: absolute;
    top: 3px;
    inset-inline-start: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform var(--fl-motion) var(--fl-ease);
  }
  .fl-item[aria-checked='true'] .fl-switch {
    background: var(--fl-accent);
  }
  .fl-item[aria-checked='true'] .fl-switch::after {
    transform: translateX(14px);
  }
  :global([dir='rtl']) .fl-item[aria-checked='true'] .fl-switch::after {
    transform: translateX(-14px);
  }
  .fl-item small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  /* The prototype hides the name at 1000px and below. */
  @media (min-width: 1001px) {
    .fl-account-name {
      display: inline;
    }
  }
</style>
