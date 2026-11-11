<script lang="ts">
  /**
   * FL-831: Your sign-in & privacy › Two-step sign-in (the approved FL-776 prototype,
   * `settings-v2/cloud/TwoStep.jsx`): a code from the authenticator app after the password. It opens on
   * whether it is on (or how few recovery codes are left), then turns it on, moves it to a new phone,
   * makes new recovery codes and turns it off, each in its own dialog. Recovery codes are shown only in
   * the dialog that made them; this page only ever knows how many are left.
   *
   * The server doesn't say when two-step sign-in was turned on, so the page leaves out the prototype's
   * "Turned on 3 November 2026". `?show=new-codes` opens Make new recovery codes (from the sign-in
   * screen after the last recovery code was used).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PasswordDialog from '$lib/components/frameleaf/access/PasswordDialog.svelte';
  import TwoStepMoveDialog from '$lib/components/frameleaf/access/two-step/TwoStepMoveDialog.svelte';
  import TwoStepNewCodesDialog from '$lib/components/frameleaf/access/two-step/TwoStepNewCodesDialog.svelte';
  import TwoStepSetupDialog from '$lib/components/frameleaf/access/two-step/TwoStepSetupDialog.svelte';
  import TwoStepTurnOffDialog from '$lib/components/frameleaf/access/two-step/TwoStepTurnOffDialog.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { LOCK_MINUTES, RECOVERY_CODE_COUNT, TRUST_DAYS, WRONG_CODES_ALLOWED } from '$lib/frameleaf/two-step';
  import { getAuthStatus, type AuthStatusResponseDto } from '@frameleaf/sdk';
  import { modalManager } from '@frameleaf/ui';
  import {
    mdiCellphoneKey,
    mdiCloudAlertOutline,
    mdiFormTextboxPassword,
    mdiKeyAlertOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/two-step.css';

  let { onSessionsChanged }: { onSessionsChanged?: () => void } = $props();

  let auth = $state<AuthStatusResponseDto | null>(null);
  let failed = $state(false);
  let said = $state('');
  let moved = $state(false);

  const load = async () => {
    failed = false;
    try {
      auth = await getAuthStatus();
    } catch {
      failed = true;
    }
  };

  onMount(async () => {
    await load();
    if (auth?.twoFactorEnabled && new URLSearchParams(location.search).get('show') === 'new-codes') {
      void newCodes();
    }
  });

  const on = $derived(!!auth?.twoFactorEnabled);
  const left = $derived(auth?.recoveryCodesRemaining ?? 0);

  const hero = $derived.by(() => {
    if (failed) {
      return {
        tone: 'warn' as const,
        icon: mdiCloudAlertOutline,
        title: $t('frameleaf_two_step_hero_error'),
        body: $t('frameleaf_two_step_hero_error_body'),
        action: 'retry' as const,
      };
    }
    if (!auth) {
      return { tone: 'quiet' as const, icon: mdiCellphoneKey, title: $t('frameleaf_two_step_hero_loading') };
    }
    if (!auth.twoFactorEnabled && !auth.password) {
      return {
        tone: 'quiet' as const,
        icon: mdiFormTextboxPassword,
        title: $t('frameleaf_two_step_hero_no_password'),
        body: $t('frameleaf_two_step_hero_no_password_body'),
      };
    }
    if (!auth.twoFactorEnabled) {
      return {
        tone: 'quiet' as const,
        icon: mdiCellphoneKey,
        title: $t('frameleaf_two_step_hero_off'),
        body: $t('frameleaf_two_step_hero_off_body'),
        action: 'turn-on' as const,
      };
    }
    if (auth.recoveryCodesRemaining <= 1) {
      return {
        tone: 'warn' as const,
        icon: mdiKeyAlertOutline,
        title: $t('frameleaf_two_step_hero_low', { values: { count: auth.recoveryCodesRemaining } }),
        body: $t('frameleaf_two_step_hero_low_body'),
        action: 'new-codes' as const,
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_two_step_hero_on'),
      body: $t('frameleaf_two_step_hero_on_body'),
    };
  });

  const turnOn = async () => {
    if (await modalManager.show(TwoStepSetupDialog, {})) {
      said = $t('frameleaf_two_step_on_said');
      await load();
    }
  };

  const newCodes = async () => {
    if (await modalManager.show(TwoStepNewCodesDialog, {})) {
      said = $t('frameleaf_two_step_codes_said', { values: { count: RECOVERY_CODE_COUNT } });
      await load();
    }
  };

  const move = async () => {
    if (await modalManager.show(TwoStepMoveDialog, {})) {
      moved = true;
      said = $t('frameleaf_two_step_moved_said');
    }
  };

  const turnOff = async () => {
    if (await modalManager.show(TwoStepTurnOffDialog, {})) {
      moved = false;
      said = $t('frameleaf_two_step_off_said');
      await load();
    }
  };

  const changePassword = async () => {
    const result = await modalManager.show(PasswordDialog, {});
    if (result?.signedOutOthers) {
      onSessionsChanged?.();
    }
  };
</script>

{#snippet heroActions()}
  {#if hero.action === 'retry'}
    <Button onclick={() => void load()}>{$t('frameleaf_two_step_try_again')}</Button>
  {:else if hero.action === 'turn-on'}
    <Button variant="primary" onclick={() => void turnOn()}>{$t('frameleaf_two_step_turn_on_open')}</Button>
  {:else if hero.action === 'new-codes'}
    <Button variant="primary" onclick={() => void newCodes()}>{$t('frameleaf_two_step_make_codes_open')}</Button>
  {/if}
{/snippet}

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_two_step_title')}
    actions={'action' in hero && hero.action ? heroActions : undefined}
  />

  {#if auth && on}
    <Section title={$t('frameleaf_two_step_yours')}>
      <Row label={$t('frameleaf_two_step_title')} help={$t('frameleaf_two_step_switch_help')}>
        <Switch label={$t('frameleaf_two_step_title')} checked onChange={() => void turnOff()} />
      </Row>
      <Row
        label={$t('frameleaf_two_step_app')}
        help={moved ? $t('frameleaf_two_step_app_moved') : $t('frameleaf_two_step_app_help')}
      >
        <Button onclick={() => void move()}>{$t('frameleaf_two_step_move_open')}</Button>
      </Row>
      <Row
        label={$t('frameleaf_two_step_codes')}
        help={$t('frameleaf_two_step_codes_help', { values: { left, count: RECOVERY_CODE_COUNT } })}
      >
        <Button onclick={() => void newCodes()}>{$t('frameleaf_two_step_codes_open')}</Button>
      </Row>
      <Row
        label={$t('frameleaf_two_step_trusted')}
        help={$t('frameleaf_two_step_trusted_help', { values: { days: TRUST_DAYS } })}
      >
        <Button onclick={() => void changePassword()}>{$t('frameleaf_two_step_change_password')}</Button>
      </Row>
    </Section>
  {:else if auth && auth.password}
    <Section title={$t('frameleaf_two_step_need_title')} description={$t('frameleaf_two_step_need_description')}>
      <Points
        rows={[
          { text: $t('frameleaf_two_step_need_app') },
          { text: $t('frameleaf_two_step_need_password') },
          { text: $t('frameleaf_two_step_need_codes', { values: { count: RECOVERY_CODE_COUNT } }) },
        ]}
      />
    </Section>
  {/if}

  <Section title={$t('frameleaf_two_step_know_title')}>
    <Points
      rows={[
        { text: $t('frameleaf_two_step_know_frameleaf') },
        { text: $t('frameleaf_two_step_know_trust', { values: { days: TRUST_DAYS } }) },
        {
          text: $t('frameleaf_two_step_know_pause', { values: { count: WRONG_CODES_ALLOWED, minutes: LOCK_MINUTES } }),
        },
        { text: $t('frameleaf_two_step_know_lost') },
      ]}
    />
    <Advanced>
      <p class="ts-advanced">{$t('frameleaf_two_step_advanced')}</p>
    </Advanced>
  </Section>
</KitPage>

<style>
  .ts-advanced {
    max-width: 720px;
    margin: 0;
    padding-top: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.55;
  }
</style>
