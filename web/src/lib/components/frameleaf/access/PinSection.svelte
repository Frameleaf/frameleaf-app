<script lang="ts">
  /**
   * Your Locked PIN, from the `pin` section of the design template's `PersonalAccess`: whether a
   * PIN is set, Create or Change PIN, Clear PIN, and "Forgot your PIN?" to clear it with the
   * account password. The state comes from the server (`getAuthStatus`) and follows PIN changes
   * made anywhere on this page.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PinDialog from '$lib/components/frameleaf/access/PinDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import type { PinDialogMode } from '$lib/frameleaf/personal-access';
  import { getAuthStatus } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './access.css';

  let pinEnabled = $state<boolean | undefined>(undefined);
  let failed = $state(false);

  const refresh = async () => {
    try {
      pinEnabled = (await getAuthStatus()).pinCode;
      failed = false;
    } catch {
      failed = true;
    }
  };

  const open = async (mode: PinDialogMode) => {
    if (await modalManager.show(PinDialog, { mode })) {
      await refresh();
    }
  };

  onMount(() => void refresh());
</script>

<OnEvents onUserPinCodeReset={() => (pinEnabled = false)} onUserPinCodeCreated={() => (pinEnabled = true)} />

<section class="fl-access-section" aria-labelledby="fl-access-pin">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-pin">{$t('frameleaf_access_pin_title')}</h3>
      <p>
        {#if failed}
          {$t('frameleaf_access_pin_unknown')}
        {:else if pinEnabled === undefined}
          {$t('loading')}
        {:else}
          {pinEnabled ? $t('frameleaf_access_pin_enabled') : $t('frameleaf_access_pin_disabled')}
        {/if}
      </p>
    </div>
    {#if pinEnabled !== undefined}
      <div class="fl-access-actions">
        <Button onclick={() => open(pinEnabled ? 'change' : 'create')}>
          {pinEnabled ? $t('frameleaf_access_pin_change') : $t('frameleaf_access_pin_create')}
        </Button>
        {#if pinEnabled}
          <Button onclick={() => open('clear')}>{$t('frameleaf_access_pin_clear')}</Button>
        {/if}
      </div>
    {:else if failed}
      <Button onclick={refresh}>{$t('frameleaf_locked_rules_try_again')}</Button>
    {/if}
  </div>
  {#if pinEnabled}
    <div>
      <Button variant="quiet" onclick={() => open('reset')}>{$t('frameleaf_access_pin_forgot')}</Button>
    </div>
  {/if}
</section>
