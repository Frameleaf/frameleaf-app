<script lang="ts">
  /**
   * FL-326 (spec §4.9, prototype `PartnerLockedNotice.jsx`): Locked items a partner shares arrive as your
   * own locked copies, which only your PIN opens. Without a PIN they stay hidden, and this notice offers
   * to set one. The server decides when to show it (`getPartnerLockedNotice`), and "Not now" dismisses it
   * for good; setting a PIN hides it too.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { dismissPartnerLockedNotice, getPartnerLockedNotice } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /** The Locked PIN section of user settings (`UserSettingsList`). */
  const PIN_SETTINGS = '/user-settings?isOpen=user-pin-code-settings';

  let show = $state(false);

  onMount(async () => {
    try {
      show = (await getPartnerLockedNotice()).show;
    } catch {
      // a notice that cannot be read is simply not shown
      show = false;
    }
  });

  const dismiss = async () => {
    show = false;
    try {
      await dismissPartnerLockedNotice();
    } catch {
      // shown again next time; nothing else depends on it
    }
  };
</script>

{#if show}
  <section class="pl-notice" role="status" aria-label={$t('frameleaf_partner_locked_notice_label')}>
    <Icon icon={mdiLockOutline} size="18" aria-hidden />
    <p>
      <strong>{$t('frameleaf_partner_locked_notice_title')}</strong>
      <span>{$t('frameleaf_partner_locked_notice_body')}</span>
    </p>
    <Button variant="primary" onclick={() => void goto(PIN_SETTINGS)}>
      {$t('frameleaf_partner_locked_notice_set_pin')}
    </Button>
    <Button onclick={() => void dismiss()}>{$t('frameleaf_partner_locked_notice_dismiss')}</Button>
  </section>
{/if}

<style>
  /* sharing.css .pl-notice */
  .pl-notice {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 12px;
    padding: 12px 14px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .pl-notice p {
    flex: 1;
    display: grid;
    gap: 2px;
    margin: 0;
    font-size: 13px;
  }
  .pl-notice p span {
    color: var(--fl-muted);
  }
  /* UI review 2026-10-30 #7: on phones the text keeps the full width and the buttons sit on a line
     below it, at its end. The notice itself is in the page's 16px gutter. */
  @media (max-width: 700px) {
    .pl-notice {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 12px;
      padding: 12px 16px;
    }
    .pl-notice p {
      flex: 1 1 calc(100% - 30px);
    }
    .pl-notice > :global(button:first-of-type) {
      margin-inline-start: auto;
    }
  }
</style>
