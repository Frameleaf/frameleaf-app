<script lang="ts">
  /**
   * "This wasn't me" (FL-824, the approved prototype's dialog in `AccountActivity.jsx`): the row
   * quoted, then the two things to do about it (change your password, sign out everywhere else),
   * with passkeys and connected apps to look through afterwards. It changes nothing by itself: each
   * button opens the page where that is done.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The row's sentence. */
    what: string;
    /** "Yesterday at 11:42 PM". */
    when: string;
    /** Someone who is not an administrator is told whom to ask. */
    member?: boolean;
    onClose: () => void;
  };
  let { what, when, member = false, onClose }: Props = $props();

  let open = $state(true);
  let next: string | undefined;
  const leave = (section: string) => {
    next = commandCenterUrl('privacy', section);
    open = false;
  };
  // As the other access dialogs: closing it tells the page, which then takes it away.
  $effect(() => {
    if (!open) {
      onClose();
      if (next) {
        void goto(next);
      }
    }
  });
</script>

<Dialog title={$t('frameleaf_account_activity_dialog_title')} closeLabel={$t('close')} bind:open>
  <div class="wasnt">
    <p class="quote">
      <strong>{what}</strong>
      <span>{when}</span>
    </p>
    <p>{$t('frameleaf_account_activity_dialog_intro')}</p>
    <ol>
      <li>
        <strong>{$t('frameleaf_account_activity_dialog_step_password_title')}</strong>
        {$t('frameleaf_account_activity_dialog_step_password')}
      </li>
      <li>
        <strong>{$t('frameleaf_account_activity_dialog_step_devices_title')}</strong>
        {$t('frameleaf_account_activity_dialog_step_devices')}
      </li>
    </ol>
    <p class="hint">
      {$t('frameleaf_account_activity_dialog_then')}
      <TextLink onclick={() => leave('passkeys')}>{$t('frameleaf_passkey_title')}</TextLink>,
      <TextLink onclick={() => leave('connected-apps')}>{$t('frameleaf_apps_title')}</TextLink>.
      {#if member}{$t('frameleaf_account_activity_dialog_ask_admin')}{/if}
    </p>
  </div>
  {#snippet actions()}
    <Button onclick={() => leave('authorized-devices')}>{$t('frameleaf_account_activity_dialog_sign_out')}</Button>
    <Button variant="primary" onclick={() => leave('password')}>
      {$t('frameleaf_account_activity_dialog_change_password')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .wasnt {
    display: grid;
    gap: var(--fl-space-4);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .wasnt p,
  .wasnt ol {
    margin: 0;
  }
  .quote {
    display: grid;
    gap: var(--fl-space-1);
    padding: var(--fl-space-3) var(--fl-space-4);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .quote strong {
    color: var(--fl-text);
    font-weight: 600;
  }
  .quote span,
  .hint {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  ol {
    display: grid;
    gap: var(--fl-space-3);
    padding-inline-start: var(--fl-space-5);
  }
  ol strong {
    font-weight: 600;
  }
</style>
