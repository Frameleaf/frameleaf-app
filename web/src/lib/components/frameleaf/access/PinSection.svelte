<script lang="ts">
  /**
   * Your Locked PIN, from the `pin` section of the design template's `PersonalAccess`: whether a
   * PIN is set, Create or Change PIN, Clear PIN, and "Forgot your PIN?" to clear it with the
   * account password. The state comes from the server (`getAuthStatus`) and follows PIN changes
   * made anywhere on this page.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import PinDialog from '$lib/components/frameleaf/access/PinDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import type { PinDialogMode } from '$lib/frameleaf/personal-access';
  import { getAuthStatus, getMyPreferences, updateMyPreferences } from '@frameleaf/sdk';
  import { modalManager, toastManager } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './access.css';

  let pinEnabled = $state<boolean | undefined>(undefined);
  let failed = $state(false);
  // FL-517: "Lock again after": how long Locked photos stay open after an unlock
  const RELOCK_CHOICES = [5, 15, 60] as const;
  let relock = $state<number | undefined>(undefined);
  let savingRelock = $state(false);
  const relockWords = (minutes: number) =>
    minutes === 60
      ? $t('frameleaf_access_relock_hour')
      : $t('frameleaf_access_relock_minutes', { values: { count: minutes } });
  const loadRelock = async () => {
    try {
      relock = (await getMyPreferences()).lockedPin?.relockMinutes ?? 60;
    } catch {
      relock = undefined;
    }
  };
  const saveRelock = async (minutes: number) => {
    const before = relock;
    relock = minutes;
    savingRelock = true;
    try {
      await updateMyPreferences({ userPreferencesUpdateDto: { lockedPin: { relockMinutes: minutes } } });
      toastManager.primary($t('frameleaf_access_relock_saved', { values: { time: relockWords(minutes) } }));
    } catch {
      relock = before;
      toastManager.warning($t('frameleaf_access_relock_failed'));
    } finally {
      savingRelock = false;
    }
  };

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

  onMount(() => {
    void refresh();
    void loadRelock();
  });
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
          <Skeleton variant="text" width="9rem" />
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
    {#if relock !== undefined}
      <label class="fl-access-relock">
        <span>
          <strong>{$t('frameleaf_access_relock_label')}</strong>
          <small>{$t('frameleaf_access_relock_help', { values: { time: relockWords(relock) } })}</small>
        </span>
        <select
          value={String(relock)}
          disabled={savingRelock}
          onchange={(event) => void saveRelock(Number(event.currentTarget.value))}
        >
          {#each RELOCK_CHOICES as minutes (minutes)}
            <option value={String(minutes)}>{relockWords(minutes)}</option>
          {/each}
        </select>
      </label>
    {/if}
    <div>
      <Button variant="quiet" onclick={() => open('reset')}>{$t('frameleaf_access_pin_forgot')}</Button>
    </div>
  {/if}
</section>

<style>
  .fl-access-relock {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    align-items: center;
    justify-content: space-between;
    margin-block: var(--fl-space-3);
  }
  .fl-access-relock span {
    display: grid;
    gap: 2px;
  }
  .fl-access-relock small {
    color: var(--fl-muted);
  }
</style>
