<script lang="ts">
  import { page } from '$app/state';
  import { clickOutside } from '$lib/actions/click-outside';
  import { focusTrap } from '$lib/actions/focus-trap';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AvatarEditModal from '$lib/modals/AvatarEditModal.svelte';
  import HelpAndFeedbackModal from '$lib/modals/HelpAndFeedbackModal.svelte';
  import { Route } from '$lib/route';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { getAboutInfo } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiAccountEditOutline,
    mdiChevronDown,
    mdiCogOutline,
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
    await modalManager.show(AvatarEditModal);
  };

  const openSupport = async () => {
    close();
    const info = userInteraction.aboutInfo ?? (await getAboutInfo());
    await modalManager.show(HelpAndFeedbackModal, { info });
  };
</script>

<div
  class="fl-account"
  use:clickOutside={{ onOutclick: close, onEscape: close }}
>
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
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={menu}
      class="fl-menu"
      role="menu"
      aria-label={$t('account_settings')}
      onkeydown={onMenuKeydown}
      use:focusTrap
    >
      <div class="fl-identity">
        <UserAvatar user={authManager.user} size="lg" noTitle />
        <div>
          <strong>{authManager.user.name}</strong>
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
      </button>

      <a href={Route.suppressed()} role="menuitem" class="fl-item" onclick={close}>
        <Icon icon={mdiShieldLockOutline} size="1.125em" aria-hidden={true} />
        <span>
          {$t('frameleaf_open_locked')}
          {#if !isElevated}<small>{$t('frameleaf_open_locked_hint')}</small>{/if}
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

      <hr />

      <button type="button" role="menuitem" class="fl-item" onclick={() => void openSupport()}>
        <Icon icon={mdiLifebuoy} size="1.125em" aria-hidden={true} />
        <span>{$t('support_and_feedback')}</span>
      </button>

      <hr />

      <a href={Route.logout()} role="menuitem" class="fl-item" onclick={close}>
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
  .fl-identity span {
    color: var(--fl-muted);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
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
  .fl-item span {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .fl-item small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .fl-item[aria-checked='true'] {
    color: var(--fl-accent);
  }
  @media (min-width: 850px) {
    .fl-account-name {
      display: inline;
    }
  }
</style>
