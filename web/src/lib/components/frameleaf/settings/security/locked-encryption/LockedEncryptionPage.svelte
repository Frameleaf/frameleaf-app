<script lang="ts">
  /**
   * Personal › Your sign-in & privacy › Locked encryption (FL-721, prototype PR 20
   * `settings-v2/cloud/LockedEncryption.jsx`). Each person turns it on for their own Locked photos
   * and videos; an administrator can't see or change it. The page opens on its state:
   *
   * - off: not encrypted, Turn on…, and what it does;
   * - on, with the PIN, or with Advanced Security (passphrase typed, until when);
   * - after a restart (Advanced, key not open): the passphrase form;
   * - encrypting, with how far it is;
   * - decrypting, and, after a restart mid-way, the PIN or passphrase that lets it finish (spec §4.3).
   *
   * Items whose files are missing keep turning off (or an unlock) waiting; the page says so (N5).
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Coverage from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import ChangeProtectionModal from '$lib/components/frameleaf/settings/security/locked-encryption/ChangeProtectionModal.svelte';
  import NewRecoveryKeyModal from '$lib/components/frameleaf/settings/security/locked-encryption/NewRecoveryKeyModal.svelte';
  import RecoverModal from '$lib/components/frameleaf/settings/security/locked-encryption/RecoverModal.svelte';
  import SecretField from '$lib/components/frameleaf/settings/security/locked-encryption/SecretField.svelte';
  import TurnOffModal from '$lib/components/frameleaf/settings/security/locked-encryption/TurnOffModal.svelte';
  import TurnOnModal from '$lib/components/frameleaf/settings/security/locked-encryption/TurnOnModal.svelte';
  import { lockedEncryptionView, untilParts, type AskAgain } from '$lib/frameleaf/locked-encryption';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    getAuthStatus,
    getLockedEncryption,
    LockedEncryptionMode,
    lockLockedEncryption,
    unlockAuthSession,
    unlockLockedEncryption,
    updateLockedEncryption,
    type LockedEncryptionStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import {
    mdiCloudLockOutline,
    mdiContentCopy,
    mdiLockOutline,
    mdiShieldKeyOutline,
    mdiShieldLockOutline,
    mdiShieldSyncOutline,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  /** The recovery tool (spec §12); the library folder is the person's own. */
  const COMMAND = 'frameleaf locked decrypt --library <library folder> --to ~/Recovered';
  const RECOVERY_TOOL_HELP = 'https://frameleaf.app/docs/using/locked-encryption/';
  /** How often a run in progress is read again. */
  const PROGRESS_POLL_MS = 5000;

  let status = $state<LockedEncryptionStatusResponseDto | undefined>();
  let failed = $state(false);
  let hasPin = $state(true);
  let said = $state('');
  let secret = $state('');
  let unlocking = $state(false);
  let unlockError = $state('');
  let savingAgain = $state(false);
  /** N2: the longer ask-again time waiting on the passphrase, and what has been typed for it. */
  let longerAgain = $state<{ askAgainHours: AskAgain } | undefined>();
  let longerOpen = $state(false);
  let longerSecret = $state('');
  /** Bumped to redraw the ask-again choice from the stored value after a cancel or a refusal. */
  let againResets = $state(0);

  const view = $derived(status ? lockedEncryptionView(status) : undefined);
  const mode = $derived(status?.mode ?? LockedEncryptionMode.Pin);
  const advanced = $derived(mode === LockedEncryptionMode.Advanced);
  const enabledViews = new Set(['pin', 'advanced', 'needs', 'working']);
  const on = $derived(view !== undefined && enabledViews.has(view));

  /** "223 Locked items"; unknown while off, as the server counts only what it has encrypted. */
  const items = $derived.by(() => {
    if (!status?.enabled) {
      return;
    }
    const count = status.progress?.total ?? status.counts.encrypted;
    return $t('frameleaf_le_items', { values: { count } });
  });
  const itemsWords = $derived(items ?? $t('frameleaf_le_items_unknown'));

  const until = $derived.by(() => {
    if (!status?.expiresAt) {
      return $t('frameleaf_le_until_restart');
    }
    const parts = untilParts(status.expiresAt, new Date(), $locale);
    return parts.kind === 'today'
      ? $t('frameleaf_le_until_today', { values: { time: parts.time } })
      : parts.kind === 'tomorrow'
        ? $t('frameleaf_le_until_tomorrow', { values: { time: parts.time } })
        : $t('frameleaf_le_until_day', { values: { day: parts.day, time: parts.time } });
  });

  const again = $derived<AskAgain>((status?.askAgainHours ?? 72) as AskAgain);
  const againWords = (hours: AskAgain) =>
    hours === null ? $t('frameleaf_le_again_restart') : $t('frameleaf_le_again_hours', { values: { hours } });
  const recoverySaved = $derived(
    status?.recoveryKeyCreatedAt
      ? new Date(status.recoveryKeyCreatedAt).toLocaleDateString($locale, { dateStyle: 'long' })
      : undefined,
  );

  const refresh = async () => {
    try {
      status = await getLockedEncryption();
      failed = false;
    } catch {
      failed = true;
    }
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    if (view !== 'working' && view !== 'decrypting') {
      return;
    }
    poll = setInterval(() => void refresh(), PROGRESS_POLL_MS);
    return () => clearInterval(poll);
  });
  onDestroy(() => clearInterval(poll));

  onMount(() => {
    void refresh();
    void (async () => {
      try {
        hasPin = (await getAuthStatus()).pinCode;
      } catch {
        // Turn on asks for the PIN anyway; the server refuses one that isn't set
      }
    })();
  });

  const turnOn = async () => {
    const result = await modalManager.show(TurnOnModal, { items });
    if (result) {
      said = $t(
        result.mode === LockedEncryptionMode.Advanced ? 'frameleaf_le_said_on_advanced' : 'frameleaf_le_said_on',
      );
      await refresh();
    }
  };
  const turnOff = async () => {
    const words = itemsWords;
    if (await modalManager.show(TurnOffModal, { mode, items })) {
      said = $t('frameleaf_le_said_off', { values: { items: words } });
      await refresh();
    }
  };
  const recover = async () => {
    if (await modalManager.show(RecoverModal, { mode })) {
      said = $t(advanced ? 'frameleaf_le_said_recovered_passphrase' : 'frameleaf_le_said_recovered_pin');
      await refresh();
    }
  };
  const newKey = async () => {
    if (await modalManager.show(NewRecoveryKeyModal, { mode })) {
      said = $t('frameleaf_le_said_new_key');
      await refresh();
    }
  };
  const changeProtection = async (change: 'add-passphrase' | 'use-pin' | 'change-passphrase') => {
    if (await modalManager.show(ChangeProtectionModal, { change })) {
      said = $t(
        change === 'add-passphrase'
          ? 'frameleaf_le_said_advanced'
          : change === 'use-pin'
            ? 'frameleaf_le_said_pin'
            : 'frameleaf_le_said_passphrase_changed',
      );
      await refresh();
    }
  };
  const lockNow = async () => {
    try {
      await lockLockedEncryption();
      said = $t('frameleaf_le_said_locked');
      await refresh();
    } catch (error) {
      said = getServerErrorMessage(error) ?? $t('frameleaf_le_lock_failed');
    }
  };
  /** Reads the stored ask-again time again and redraws the choice, which otherwise keeps the refused one. */
  const snapBackAgain = async () => {
    await refresh();
    againResets += 1;
  };
  const sendAgain = async (askAgainHours: AskAgain, currentSecret?: string) => {
    const before = again;
    savingAgain = true;
    try {
      await updateLockedEncryption({
        lockedEncryptionUpdateDto: currentSecret === undefined ? { askAgainHours } : { askAgainHours, currentSecret },
      });
      await refresh();
    } catch (error) {
      const refused = [401, 403].includes((error as { status?: number } | undefined)?.status ?? 0);
      said = refused
        ? $t('frameleaf_le_again_refused', { values: { time: againWords(before) } })
        : $t('frameleaf_le_change_failed');
      await snapBackAgain();
    } finally {
      savingAgain = false;
    }
  };
  /**
   * Shortening the time is sent as it is. Keeping Locked open longer (or until a restart) needs the
   * passphrase first (M3): the page asks for it, and the server checks it.
   */
  const saveAgain = async (value: string) => {
    const askAgainHours = (value === 'restart' ? null : Number(value)) as AskAgain;
    const longer = again !== null && (askAgainHours === null || askAgainHours > again);
    if (!longer) {
      await sendAgain(askAgainHours);
      return;
    }
    longerSecret = '';
    longerAgain = { askAgainHours };
    longerOpen = true;
  };
  const confirmLonger = async (event?: Event) => {
    event?.preventDefault();
    if (!longerAgain || longerSecret.length === 0 || savingAgain) {
      return;
    }
    const { askAgainHours } = longerAgain;
    const currentSecret = longerSecret;
    longerAgain = undefined;
    longerSecret = '';
    longerOpen = false;
    await sendAgain(askAgainHours, currentSecret);
  };
  /** Closed without sending (Cancel, X or Escape): nothing changes, and the choice goes back. */
  const longerClosed = () => {
    longerSecret = '';
    if (longerAgain) {
      longerAgain = undefined;
      void snapBackAgain();
    }
  };

  /** The hero's form: the passphrase after a restart, or the PIN or passphrase that finishes turning off. */
  const pinForm = $derived(view === 'finish' && !advanced);
  const unlockReady = $derived(pinForm ? isCompletePin(secret) : secret.length > 0);
  const unlock = async (event?: Event) => {
    event?.preventDefault();
    if (unlocking || !unlockReady) {
      return;
    }
    unlocking = true;
    unlockError = '';
    try {
      await (pinForm
        ? unlockAuthSession({ sessionUnlockDto: { pinCode: secret } })
        : unlockLockedEncryption({ lockedEncryptionUnlockDto: { passphrase: secret } }));
      await refresh();
      if (view === 'advanced') {
        said = $t('frameleaf_le_said_unlocked', { values: { until } });
      }
    } catch (error) {
      unlockError = getServerErrorMessage(error) ?? $t('frameleaf_le_unlock_failed');
    } finally {
      secret = '';
      unlocking = false;
    }
  };

  const AGAIN_OPTIONS = ['8', '24', '72', 'restart'] as const;
</script>

{#snippet unlockForm()}
  <form class="le-unlock" autocomplete="off" onsubmit={unlock}>
    {#if pinForm}
      <PinCells bind:value={secret} label={$t('frameleaf_le_locked_pin')} disabled={unlocking} />
    {:else}
      <input
        class="le-text"
        type="password"
        autocomplete="current-password"
        maxlength={1024}
        aria-label={$t('frameleaf_le_passphrase')}
        placeholder={$t('frameleaf_le_passphrase')}
        disabled={unlocking}
        bind:value={secret}
      />
    {/if}
    <Button type="submit" variant="primary" disabled={unlocking || !unlockReady}>{$t('frameleaf_le_unlock')}</Button>
    <TextLink onclick={() => void recover()}>{$t('frameleaf_le_forgot')}</TextLink>
    {#if unlockError}
      <p class="le-error" role="alert">{unlockError}</p>
    {/if}
  </form>
{/snippet}

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  {#if failed && !status}
    <Notice tone="warn" title={$t('frameleaf_le_load_failed')}>
      {#snippet action()}<Button onclick={() => void refresh()}>{$t('frameleaf_le_try_again')}</Button>{/snippet}
    </Notice>
  {:else if status && view}
    {#if view === 'off'}
      <Hero
        tone="quiet"
        icon={mdiShieldLockOutline}
        title={$t('frameleaf_le_off_title')}
        body={$t('frameleaf_le_off_body')}
        label={$t('frameleaf_le_title')}
      >
        {#snippet actions()}
          {#if hasPin}
            <Button variant="primary" onclick={() => void turnOn()}>{$t('frameleaf_le_turn_on')}</Button>
          {:else}
            <Button variant="primary" onclick={() => goto(commandCenterUrl('privacy', 'user-pin-code-settings'))}>
              {$t('frameleaf_le_set_pin_first')}
            </Button>
          {/if}
        {/snippet}
      </Hero>
    {:else if view === 'working' || view === 'decrypting'}
      {@const done = status.progress?.done ?? 0}
      {@const total = status.progress?.total ?? 0}
      <Hero
        tone="good"
        icon={mdiShieldSyncOutline}
        title={$t(view === 'working' ? 'frameleaf_le_working_title' : 'frameleaf_le_decrypting_title')}
        body={$t(view === 'working' ? 'frameleaf_le_working_body' : 'frameleaf_le_decrypting_body', {
          values: { done, total },
        })}
        label={$t('frameleaf_le_title')}
      >
        <div class="le-progress">
          <meter
            aria-label={$t(view === 'working' ? 'frameleaf_le_working_meter' : 'frameleaf_le_decrypting_meter')}
            min={0}
            max={Math.max(total, 1)}
            value={done}
          ></meter>
        </div>
      </Hero>
    {:else if view === 'needs' || view === 'finish'}
      <Hero
        tone="warn"
        icon={mdiShieldKeyOutline}
        title={view === 'needs'
          ? $t('frameleaf_le_needs_title')
          : $t(advanced ? 'frameleaf_le_finish_title_passphrase' : 'frameleaf_le_finish_title_pin')}
        body={view === 'needs' ? $t('frameleaf_le_needs_body') : $t('frameleaf_le_finish_body')}
        label={$t('frameleaf_le_title')}
      >
        {@render unlockForm()}
      </Hero>
    {:else}
      <Hero
        tone="good"
        icon={mdiShieldLockOutline}
        title={$t('frameleaf_le_on_title')}
        body={view === 'advanced'
          ? $t('frameleaf_le_on_body_advanced', { values: { until } })
          : $t('frameleaf_le_on_body_pin')}
        label={$t('frameleaf_le_title')}
      >
        <Coverage
          rows={[
            {
              icon: mdiLockOutline,
              name: $t('frameleaf_le_coverage_locked'),
              detail: $t('frameleaf_le_coverage_locked_detail'),
              tone: 'good',
              value: $t('frameleaf_le_coverage_locked_value', { values: { count: status.counts.encrypted } }),
            },
            {
              icon: mdiCloudLockOutline,
              name: $t('frameleaf_le_coverage_backups'),
              detail: $t('frameleaf_le_coverage_backups_detail'),
              tone: 'good',
              value: $t('frameleaf_le_coverage_backups_value'),
            },
          ]}
        />
      </Hero>
    {/if}

    {#if (status.counts.missing ?? 0) > 0}
      <Notice tone="warn" title={$t('frameleaf_le_missing_title', { values: { count: status.counts.missing } })}>
        {$t(view === 'decrypting' || view === 'finish' ? 'frameleaf_le_missing_off' : 'frameleaf_le_missing_unlock')}
      </Notice>
    {/if}
    {#if status.enabled && status.counts.notEncryptable > 0}
      <Notice tone="info">
        {$t('frameleaf_le_not_encryptable', { values: { count: status.counts.notEncryptable } })}
      </Notice>
    {/if}
    {#if status.enabled && (status.counts.sharedNotEncrypted ?? 0) > 0}
      <Notice tone="info">
        {$t('frameleaf_le_shared_not_encrypted', { values: { count: status.counts.sharedNotEncrypted } })}
      </Notice>
    {/if}

    {#if view === 'off'}
      <Section title={$t('frameleaf_le_what_title')} description={$t('frameleaf_le_what_description')}>
        <Points
          rows={[
            { text: $t('frameleaf_le_what_files') },
            { text: $t('frameleaf_le_what_only_you') },
            { text: $t('frameleaf_le_what_backups') },
            { text: $t('frameleaf_le_what_later') },
            { text: $t('frameleaf_le_what_details'), not: true },
            { text: $t('frameleaf_le_what_copies'), not: true },
          ]}
        />
      </Section>
    {/if}

    {#if on}
      <Section title={$t('frameleaf_le_how_title')}>
        <Row
          label={$t(advanced ? 'frameleaf_le_how_advanced' : 'frameleaf_le_how_pin')}
          help={$t(advanced ? 'frameleaf_le_how_advanced_help' : 'frameleaf_le_how_pin_help')}
        >
          <Button
            disabled={view === 'working' || view === 'needs'}
            onclick={() => void changeProtection(advanced ? 'use-pin' : 'add-passphrase')}
          >
            {$t(advanced ? 'frameleaf_le_use_pin' : 'frameleaf_le_add_passphrase')}
          </Button>
        </Row>
        {#if advanced}
          <Row
            label={$t('frameleaf_le_again_label')}
            help={again === null
              ? $t('frameleaf_le_again_help_restart')
              : $t('frameleaf_le_again_help_hours', { values: { time: againWords(again) } })}
          >
            <div class="le-again">
              {#key againResets}
                <SegmentedControl
                  label={$t('frameleaf_le_again_label')}
                  value={again === null ? 'restart' : String(again)}
                  disabled={savingAgain || longerOpen}
                  options={AGAIN_OPTIONS.map((value) => ({
                    value,
                    label: againWords(value === 'restart' ? null : (Number(value) as AskAgain)),
                  }))}
                  onChange={(value) => void saveAgain(value)}
                />
              {/key}
            </div>
          </Row>
          <Row label={$t('frameleaf_le_passphrase')} help={$t('frameleaf_le_passphrase_help')}>
            <div class="le-inline">
              <Button disabled={view === 'working'} onclick={() => void changeProtection('change-passphrase')}>
                {$t('frameleaf_le_change_passphrase')}
              </Button>
              {#if view === 'advanced'}
                <Button onclick={() => void lockNow()}>{$t('frameleaf_le_lock_now')}</Button>
              {/if}
            </div>
          </Row>
        {/if}
      </Section>

      <Section title={$t('frameleaf_le_recovery_title')} description={$t('frameleaf_le_recovery_description')}>
        <Row
          label={recoverySaved
            ? $t('frameleaf_le_recovery_saved', { values: { date: recoverySaved } })
            : $t('frameleaf_le_recovery_key')}
          help={$t('frameleaf_le_recovery_help')}
        >
          <Button disabled={view === 'needs'} onclick={() => void newKey()}>{$t('frameleaf_le_new_key')}</Button>
        </Row>
        <Row label={$t('frameleaf_le_forgot_label')} help={$t('frameleaf_le_forgot_help')}>
          <Button onclick={() => void recover()}>{$t('frameleaf_le_use_recovery_key')}</Button>
        </Row>
      </Section>

      <Section title={$t('frameleaf_le_server_title')} description={$t('frameleaf_le_server_description')}>
        <ol class="le-steps" aria-label={$t('frameleaf_le_server_title')}>
          <li>
            <span class="le-step-number" aria-hidden="true">1</span>
            <div>
              <strong>{$t('frameleaf_le_server_step_copy')}</strong>
              <p>{$t('frameleaf_le_server_step_copy_detail')}</p>
            </div>
          </li>
          <li>
            <span class="le-step-number" aria-hidden="true">2</span>
            <div>
              <strong>{$t('frameleaf_le_server_step_run')}</strong>
              <span class="le-command">
                <code>{COMMAND}</code>
                <Button
                  onclick={async () => {
                    try {
                      await navigator.clipboard.writeText(COMMAND);
                      said = $t('frameleaf_le_said_command_copied');
                    } catch {
                      said = $t('frameleaf_le_key_copy_failed');
                    }
                  }}
                >
                  <Icon icon={mdiContentCopy} size="16" aria-hidden />
                  {$t('frameleaf_le_copy_command')}
                </Button>
              </span>
            </div>
          </li>
          <li>
            <span class="le-step-number" aria-hidden="true">3</span>
            <div>
              <strong>
                {$t(advanced ? 'frameleaf_le_server_step_type_passphrase' : 'frameleaf_le_server_step_type_pin')}
              </strong>
              <p>{$t('frameleaf_le_server_step_type_detail')}</p>
            </div>
          </li>
        </ol>
        <p class="le-hint">
          <TextLink href={RECOVERY_TOOL_HELP} external>{$t('frameleaf_le_server_help')}</TextLink>
        </p>
      </Section>

      <Section title={$t('frameleaf_le_turn_off_title')}>
        <Row
          label={$t('frameleaf_le_turn_off_label')}
          help={view === 'needs'
            ? $t('frameleaf_le_turn_off_needs')
            : $t('frameleaf_le_turn_off_help', { values: { items: itemsWords } })}
        >
          <Button variant="danger" disabled={view === 'needs' || view === 'working'} onclick={() => void turnOff()}>
            {$t('frameleaf_le_turn_off')}
          </Button>
        </Row>
      </Section>
    {/if}
  {/if}
</KitPage>

{#if longerAgain}
  <Dialog
    title={$t('frameleaf_le_again_secret_title')}
    closeLabel={$t('close')}
    bind:open={longerOpen}
    onClosed={longerClosed}
  >
    <form class="le-form" autocomplete="off" onsubmit={confirmLonger}>
      <p>
        {longerAgain.askAgainHours === null
          ? $t('frameleaf_le_again_secret_body_restart')
          : $t('frameleaf_le_again_secret_body_hours', { values: { time: againWords(longerAgain.askAgainHours) } })}
      </p>
      <SecretField kind="passphrase" bind:value={longerSecret} autofocus />
    </form>
    {#snippet actions()}
      <Button onclick={() => (longerOpen = false)}>{$t('frameleaf_le_cancel')}</Button>
      <Button variant="primary" disabled={longerSecret.length === 0} onclick={() => void confirmLonger()}>
        {$t('frameleaf_le_again_secret_confirm')}
      </Button>
    {/snippet}
  </Dialog>
{/if}
