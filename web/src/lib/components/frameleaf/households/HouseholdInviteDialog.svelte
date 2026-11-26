<script lang="ts">
  /**
   * The invitation an administrator passes on (prototype `InviteDialog`, households.jsx): the long
   * form and the short code, each with Copy, and when it stops working. Linking needs nothing more
   * from this side, so the only action is Done.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { copyToClipboard } from '$lib/utils';
  import type { HouseholdInvitationDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClockOutline, mdiContentCopy } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  let {
    invitation,
    open = $bindable(false),
  }: {
    invitation: HouseholdInvitationDto;
    open?: boolean;
  } = $props();

  let copied = $state('');

  const expires = $derived(new Date(invitation.expiresAt));
  const date = $derived(
    new Intl.DateTimeFormat($locale ?? undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(expires),
  );
  const days = $derived(Math.max(1, Math.round((expires.getTime() - Date.now()) / 86_400_000)));

  const copy = async (label: string, value: string) => {
    if (await copyToClipboard(value)) {
      copied = $t('frameleaf_households_copied', { values: { label } });
    }
  };
</script>

{#snippet copyable(label: string, value: string, isCode: boolean)}
  <div class="copyable">
    <span>{label}</span>
    <div>
      <output class:is-code={isCode}>{value}</output>
      <Button label="{$t('frameleaf_households_copy')} {label}" onclick={() => void copy(label, value)}>
        <Icon icon={mdiContentCopy} size="18" aria-hidden />
        {$t('frameleaf_households_copy')}
      </Button>
    </div>
  </div>
{/snippet}

<Dialog title={$t('frameleaf_households_invite_action')} closeLabel={$t('close')} bind:open>
  {#snippet actions()}
    <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
  {/snippet}
  <div class="invite">
    <p class="lead">{$t('frameleaf_households_invite_lead')}</p>
    {@render copyable($t('frameleaf_households_link_label'), invitation.token, false)}
    {@render copyable($t('frameleaf_households_code_label'), invitation.code, true)}
    <p class="expiry">
      <Icon icon={mdiClockOutline} size="16" aria-hidden />
      {$t('frameleaf_households_invite_expiry', { values: { date, count: days } })}
    </p>
    <p class="hint">{$t('frameleaf_households_invite_no_confirm')}</p>
    <p class="copied" role="status">{copied}</p>
  </div>
</Dialog>

<style>
  .lead {
    margin: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    line-height: 1.55;
  }
  .copyable {
    display: grid;
    gap: var(--fl-space-2);
    margin-bottom: var(--fl-space-5);
  }
  .copyable > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .copyable > div {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
  output {
    display: block;
    flex: 1;
    min-width: 0;
    padding: 10px var(--fl-space-3);
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-control-track, var(--fl-raised));
    font-size: var(--fl-font-callout);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  output.is-code {
    padding-block: 13px;
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.12em;
  }
  .expiry {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    margin: 0 0 var(--fl-space-2);
    font-weight: 500;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .copied {
    min-height: 20px;
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
