<script lang="ts">
  /**
   * Your Locked PIN, from the `pin` section of the design template's `PersonalAccess`: whether a
   * PIN is set, Create or Change PIN, Clear PIN, and "Forgot it?" to clear it with the
   * account password. The state comes from the server (`getAuthStatus`) and follows PIN changes
   * made anywhere on this page.
   *
   * FL-721 (prototype PR 20 `Personal.jsx` LockedPin): while Locked encryption is on, the PIN can't be
   * cleared, "Forgot it?" asks for the recovery key instead of the password, and a row opens the
   * Locked encryption page.
   *
   * Drawn as the approved prototype's `LockedPin` (`settings-v2/cloud/Personal.jsx`): a hero that says
   * whether the PIN guards the Locked photos, "Your PIN" (change, forgot, clear, Locked encryption and
   * how soon they lock again) and "What gets Locked" (Always Locked). The prototype's two switches
   * there (suggested private photos, location on public previews) have no per-person setting on the
   * server yet, so they are not drawn.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import RecoverModal from '$lib/components/frameleaf/settings/security/locked-encryption/RecoverModal.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import PinDialog from '$lib/components/frameleaf/access/PinDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import type { PinDialogMode } from '$lib/frameleaf/personal-access';
  import {
    getAuthStatus,
    getLockedEncryption,
    getMyPreferences,
    LockedEncryptionMode,
    updateMyPreferences,
    type LockedEncryptionStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, modalManager, toastManager } from '@frameleaf/ui';
  import { mdiChevronRight, mdiLockCheckOutline, mdiLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';

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

  let encryption = $state<LockedEncryptionStatusResponseDto | undefined>();
  const encrypted = $derived(encryption?.enabled === true);
  /** Unknown until read, and when it can't be read: Clear PIN stays disabled, as the server may refuse it. */
  const encryptionKnown = $derived(encryption !== undefined);
  const loadEncryption = async () => {
    try {
      encryption = await getLockedEncryption();
    } catch {
      encryption = undefined;
    }
  };
  /** FL-721: with encryption on, only the recovery key resets a forgotten PIN. */
  const forgot = async () => {
    if (!encrypted) {
      await open('reset');
      return;
    }
    if (await modalManager.show(RecoverModal, { mode: LockedEncryptionMode.Pin })) {
      toastManager.primary($t('frameleaf_le_said_recovered_pin'));
      await refresh();
    }
  };

  onMount(() => {
    void refresh();
    void loadRelock();
    void loadEncryption();
  });
</script>

<OnEvents onUserPinCodeReset={() => (pinEnabled = false)} onUserPinCodeCreated={() => (pinEnabled = true)} />

{#snippet setPin()}
  <Button variant="primary" onclick={() => open('create')}>{$t('frameleaf_access_pin_set_one')}</Button>
{/snippet}
{#snippet tryAgain()}
  <Button onclick={refresh}>{$t('frameleaf_locked_rules_try_again')}</Button>
{/snippet}

<KitPage>
  {#if failed}
    <Hero
      tone="warn"
      icon={mdiLockOutline}
      title={$t('frameleaf_access_pin_unknown')}
      label={$t('frameleaf_access_pin_title')}
      actions={tryAgain}
    />
  {:else if pinEnabled === true}
    <Hero
      tone="good"
      icon={mdiLockCheckOutline}
      title={$t('frameleaf_access_pin_hero_set')}
      body={$t('frameleaf_access_pin_hero_set_body', { values: { time: relockWords(relock ?? 60) } })}
      label={$t('frameleaf_access_pin_title')}
    />
  {:else if pinEnabled === false}
    <Hero
      tone="warn"
      icon={mdiLockOutline}
      title={$t('frameleaf_access_pin_hero_none')}
      body={$t('frameleaf_access_pin_hero_none_body')}
      label={$t('frameleaf_access_pin_title')}
      actions={setPin}
    />
  {/if}

  {#if pinEnabled}
    <Section title={$t('frameleaf_access_pin_yours')}>
      <Row
        label={$t('frameleaf_access_pin_six')}
        help={encrypted ? $t('frameleaf_le_pin_encrypted_help') : $t('frameleaf_access_pin_six_help')}
      >
        <div class="inline">
          <Button onclick={() => open('change')}>{$t('frameleaf_access_pin_change')}</Button>
          <Button onclick={() => void forgot()}>{$t('frameleaf_le_forgot')}</Button>
        </div>
      </Row>
      {#if !encrypted}
        <Row label={$t('frameleaf_access_pin_clear')} help={$t('frameleaf_access_pin_clear_help')}>
          <Button variant="danger" disabled={!encryptionKnown} onclick={() => open('clear')}
            >{$t('frameleaf_access_pin_clear_more')}</Button
          >
        </Row>
      {/if}
      <!-- FL-721 (prototype LockedPin): Locked encryption sits straight under the PIN itself -->
      <Row
        label={$t('frameleaf_le_title')}
        help={encryptionKnown
          ? encrypted
            ? encryption?.mode === LockedEncryptionMode.Advanced
              ? $t('frameleaf_le_pin_row_on_advanced')
              : $t('frameleaf_le_pin_row_on')
            : $t('frameleaf_le_pin_row_off')
          : undefined}
      >
        <Button onclick={() => goto(commandCenterUrl('privacy', 'locked-encryption'))}>
          {$t('frameleaf_le_open')}
          <Icon icon={mdiChevronRight} size="1em" aria-hidden />
        </Button>
      </Row>
      {#if relock !== undefined}
        <Row
          label={$t('frameleaf_access_relock_label')}
          help={$t('frameleaf_access_relock_help_safer', { values: { time: relockWords(relock) } })}
        >
          <SegmentedControl
            label={$t('frameleaf_access_relock_label')}
            value={String(relock)}
            disabled={savingRelock}
            options={RELOCK_CHOICES.map((minutes) => ({
              value: String(minutes),
              label: minutes === 60 ? $t('frameleaf_access_relock_hour_short') : relockWords(minutes),
            }))}
            onChange={(value) => void saveRelock(Number(value))}
          />
        </Row>
      {/if}
    </Section>
  {/if}

  {#if pinEnabled !== undefined}
    <Section title={$t('frameleaf_access_pin_what')}>
      <Row label={$t('frameleaf_locked_rules_section_title')} help={$t('frameleaf_access_pin_always_help')}>
        <Button onclick={() => goto(commandCenterUrl('privacy', 'suppressed-content'))}>
          {$t('frameleaf_le_open')}
          <Icon icon={mdiChevronRight} size="1em" aria-hidden />
        </Button>
      </Row>
    </Section>
  {/if}
</KitPage>

<style>
  .inline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
</style>
