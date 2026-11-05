<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Remote access: the server's name on frameleaf.net (FL-1197, approved design
   * 2026-11-04 `FrameleafName.jsx`), shown, copied and changed with a live check as it is typed. Claiming
   * it is `PUT admin/cloud/remote/name`; the old name keeps working for 30 days.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { formatDateTime } from '$lib/frameleaf/cloud-ml';
  import { nameRule, tidyName } from '$lib/frameleaf/frameleaf-name';
  import { copyToClipboard } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    checkRemoteName,
    setRemoteName,
    type RemoteNameCheckResponseDto,
    type RemoteNameStateResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiContentCopy, mdiWeb } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  const SUFFIX = 'frameleaf.net';
  /** How long typing pauses before Frameleaf Cloud is asked. */
  const CHECK_MS = 350;

  interface Props {
    name: string | null;
    previous?: RemoteNameStateResponseDto['previous'];
    onSaved: (state: RemoteNameStateResponseDto, message: string) => void;
  }
  let { name, previous = [], onSaved }: Props = $props();

  let editing = $state(false);
  let draft = $state('');
  let check = $state<RemoteNameCheckResponseDto | null>(null);
  let saving = $state(false);
  let failure = $state('');

  const open = $derived(editing || !name);
  const same = $derived(!!name && draft === name);
  const rule = $derived(draft ? nameRule(draft) : null);
  // the server's answer counts only for what is typed now
  const answer = $derived(check?.name === draft ? check : null);
  const reason = $derived(rule ?? answer?.reason ?? null);
  const free = $derived(!same && !rule && answer?.verdict === 'available');

  $effect(() => {
    const typed = draft;
    if (!open || !typed || same || nameRule(typed)) {
      return;
    }
    const timer = setTimeout(() => {
      // an answer for a name no longer typed is dropped, so a slow one can't replace the current one
      checkRemoteName({ remoteNameUpdateDto: { name: typed } })
        .then((result) => {
          if (typed === draft) {
            check = result;
          }
        })
        .catch(() => {
          if (typed === draft) {
            check = null;
          }
        });
    }, CHECK_MS);
    return () => clearTimeout(timer);
  });

  const status = $derived.by(() => {
    if (!draft) {
      return '';
    }
    if (same) {
      return $t('frameleaf_name_current');
    }
    if (reason) {
      return $t(`frameleaf_name_reason_${reason}`);
    }
    if (answer && !free) {
      return answer.message ?? $t('frameleaf_name_unavailable');
    }
    return free
      ? $t('frameleaf_name_free', { values: { address: `${draft}.${SUFFIX}` } })
      : $t('frameleaf_name_checking');
  });

  const start = () => {
    draft = name ?? '';
    failure = '';
    editing = true;
  };

  const save = async () => {
    saving = true;
    failure = '';
    try {
      const state = await setRemoteName({ remoteNameUpdateDto: { name: draft } });
      editing = false;
      onSaved(
        state,
        name
          ? $t('frameleaf_name_changed', { values: { address: state.address, old: `${name}.${SUFFIX}` } })
          : $t('frameleaf_name_claimed', { values: { address: state.address } }),
      );
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      saving = false;
    }
  };
</script>

<div class="fln">
  {#if name}
    <div class="fln-current">
      <span class="fln-address">
        <Icon icon={mdiWeb} size="20" aria-hidden />
        <span><strong>{name}</strong>.{SUFFIX}</span>
      </span>
      <span class="fln-actions">
        <Button onclick={() => void copyToClipboard(`https://${name}.${SUFFIX}`)}>
          <Icon icon={mdiContentCopy} size="16" aria-hidden />{$t('frameleaf_name_copy')}
        </Button>
        {#if !editing}
          <Button onclick={start}>{$t('frameleaf_name_change')}</Button>
        {/if}
      </span>
    </div>
  {/if}
  {#each previous as old (old.name)}
    <p class="fln-hint">
      {$t('frameleaf_name_previous', {
        values: { address: old.address, date: formatDateTime(old.redirectUntil, $locale) },
      })}
    </p>
  {/each}
  {#if open}
    <div class="fln-edit">
      <label class="fln-field">
        <span class="fln-label">{name ? $t('frameleaf_name_new') : $t('frameleaf_name_choose')}</span>
        <span class="fln-input">
          <span aria-hidden="true">https://</span>
          <input
            value={draft}
            aria-label={$t('frameleaf_name_input')}
            autocomplete="off"
            spellcheck={false}
            maxlength={40}
            oninput={(event) => {
              draft = tidyName(event.currentTarget.value);
              event.currentTarget.value = draft;
            }}
          />
          <span aria-hidden="true">.{SUFFIX}</span>
        </span>
      </label>
      {#if status}
        <p class="fln-check" class:is-bad={!!reason || (answer && !free && !same)} class:is-ok={free} role="status">
          <Icon icon={free || same ? mdiCheckCircleOutline : mdiAlertCircleOutline} size="16" aria-hidden />
          {status}
        </p>
      {/if}
      <p class="fln-hint">{name ? $t('frameleaf_name_hint_change') : $t('frameleaf_name_hint')}</p>
      {#if failure}<p class="fln-check is-bad" role="alert">{failure}</p>{/if}
      <span class="fln-actions">
        <Button variant="primary" disabled={!free || saving} onclick={() => void save()}
          >{free
            ? $t('frameleaf_name_use', { values: { address: `${draft}.${SUFFIX}` } })
            : $t('frameleaf_name_use_this')}</Button
        >
        {#if name}
          <Button onclick={() => (editing = false)}>{$t('cancel')}</Button>
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .fln {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--fl-space-3);
  }
  .fln-current {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: linear-gradient(90deg, var(--fl-accent-soft), transparent 70%), var(--fl-raised);
  }
  .fln-address {
    display: inline-flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-lg);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .fln-address :global(svg) {
    flex: none;
    color: var(--fl-accent);
  }
  .fln-address strong {
    color: var(--fl-text);
    font-weight: 600;
  }
  .fln-actions {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .fln-edit {
    display: grid;
    gap: 10px;
    padding: 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .fln-field {
    display: grid;
    gap: 6px;
  }
  .fln-label {
    font-weight: 600;
  }
  .fln-input {
    display: flex;
    align-items: center;
    max-width: 560px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control, 8px);
    background: var(--fl-raised);
    color: var(--fl-subtle, var(--fl-muted));
    font-variant-numeric: tabular-nums;
  }
  .fln-input:focus-within {
    border-color: var(--fl-accent);
    box-shadow: 0 0 0 3px var(--fl-accent-soft);
  }
  .fln-input input {
    flex: 1;
    min-width: 60px;
    min-height: 38px;
    padding: 0 2px;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
    outline: none;
  }
  .fln-check {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    color: var(--fl-muted);
  }
  .fln-check.is-ok {
    color: var(--fl-accent-strong, var(--fl-accent));
  }
  .fln-check.is-bad {
    color: var(--fl-warning);
  }
  .fln-hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
