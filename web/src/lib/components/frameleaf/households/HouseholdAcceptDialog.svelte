<script lang="ts">
  /**
   * Accepting another household's invitation (prototype `AcceptDialog`): paste or type it, see whose
   * it is, optionally name the household, then link. A refused invitation always reads the same,
   * whether it was mistyped, used, expired or never existed, so the field cannot be used to find
   * out which codes are real.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { invitationCode } from '$lib/frameleaf/linked-households';
  import { handleError } from '$lib/utils/handle-error';
  import {
    acceptHouseholdInvitation,
    isHttpError,
    previewHouseholdInvitation,
    type HouseholdLinkDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiHomeGroup } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    onLinked,
  }: {
    open?: boolean;
    onLinked: (link: HouseholdLinkDto) => void;
  } = $props();

  let input = $state('');
  let name = $state('');
  let from = $state<string>();
  let wrong = $state(false);
  let busy = $state(false);

  const code = $derived(invitationCode(input));

  /** The server's refusals are all the same to the person; only an outage is a different problem. */
  const refused = (error: unknown) => isHttpError(error) && error.status >= 400 && error.status < 500;

  const preview = async () => {
    busy = true;
    wrong = false;
    try {
      const invitation = await previewHouseholdInvitation({ code });
      from = invitation.name;
      name = invitation.name;
    } catch (error) {
      if (refused(error)) {
        wrong = true;
      } else {
        handleError(error, $t('frameleaf_households_error'));
      }
    } finally {
      busy = false;
    }
  };

  const link = async () => {
    busy = true;
    try {
      const householdName = name.trim();
      const linked = await acceptHouseholdInvitation({
        householdInvitationAcceptDto: { code, ...(householdName ? { householdName } : {}) },
      });
      open = false;
      onLinked(linked);
    } catch (error) {
      if (refused(error)) {
        from = undefined;
        wrong = true;
      } else {
        handleError(error, $t('frameleaf_households_error'));
      }
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_households_accept_action')} closeLabel={$t('close')} bind:open>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    {#if from === undefined}
      <Button variant="primary" disabled={busy || !code} onclick={() => void preview()}>
        {$t('frameleaf_households_accept_continue')}
      </Button>
    {:else}
      <Button variant="primary" disabled={busy} onclick={() => void link()}>
        {$t('frameleaf_households_accept_link')}
      </Button>
    {/if}
  {/snippet}
  <div class="accept">
    {#if from === undefined}
      <p class="lead">{$t('frameleaf_households_accept_lead')}</p>
      <label class="field">
        <span>{$t('frameleaf_households_accept_field')}</span>
        <input
          data-initial-focus
          bind:value={input}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={wrong || undefined}
          oninput={() => (wrong = false)}
        />
      </label>
      {#if wrong}
        <p class="error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden />
          {$t('frameleaf_households_accept_wrong')}
        </p>
      {/if}
      <p class="hint">{$t('frameleaf_households_needs')}</p>
    {:else}
      <div class="preview">
        <span class="tile" aria-hidden="true"><Icon icon={mdiHomeGroup} size="22" /></span>
        <div>
          <small>{$t('frameleaf_households_accept_from')}</small>
          <strong>{from}</strong>
        </div>
      </div>
      <p class="lead">{$t('frameleaf_households_accept_check')}</p>
      <label class="field">
        <span>{$t('frameleaf_households_accept_name')}</span>
        <input data-initial-focus bind:value={name} maxlength="80" autocomplete="off" />
        <small>{$t('frameleaf_households_name_help')}</small>
      </label>
    {/if}
  </div>
</Dialog>

<style>
  .lead {
    margin: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    line-height: 1.55;
  }
  .field {
    display: grid;
    gap: var(--fl-space-2);
    margin-bottom: var(--fl-space-5);
  }
  .field > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .field input {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .field input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  .field small,
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
    margin: calc(var(--fl-space-2) * -1) 0 var(--fl-space-5);
    color: var(--fl-danger);
    font-size: var(--fl-font-callout);
  }
  .error :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .preview {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    margin-bottom: var(--fl-space-5);
    padding: var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--fl-radius-card);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    color: var(--fl-accent);
  }
  .preview small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .preview strong {
    font-size: 17px;
  }
</style>
