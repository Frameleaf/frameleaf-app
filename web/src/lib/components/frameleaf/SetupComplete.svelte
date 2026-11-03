<script lang="ts">
  /*
   * Completion window (FL-1146, owner 2026-11-02; prototype SetupComplete.jsx): when everything an Immich import
   * set off has finished, the next page load opens this window once, with a burst of confetti.
   */
  import { confetti } from '$lib/frameleaf/confetti';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import type { LibrarySetupProgressDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountGroupOutline,
    mdiAlertCircleOutline,
    mdiCheckBold,
    mdiChevronRight,
    mdiImageAlbum,
    mdiImageMultipleOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    progress: LibrarySetupProgressDto;
    onClose: () => void;
  }

  let { progress, onClose }: Props = $props();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) {
      return;
    }
    dialog.showModal();
    return confetti({ parent: dialog });
  });

  const facts = $derived([
    [mdiImageMultipleOutline, progress.items, $t('setup_complete_items', { values: { count: progress.items } })],
    [mdiAccountGroupOutline, progress.people, $t('setup_complete_people')],
    [mdiImageAlbum, progress.albums, $t('setup_complete_albums')],
  ] as const);
</script>

<dialog
  bind:this={dialog}
  class="fl-setup-complete"
  aria-labelledby="fl-setup-complete-title"
  oncancel={(event) => {
    event.preventDefault();
    onClose();
  }}
>
  <div class="fl-setup-complete-mark" aria-hidden="true">
    <Icon icon={mdiCheckBold} size="40" />
  </div>
  <h2 id="fl-setup-complete-title">{$t('setup_complete_title')}</h2>
  <p>{$t('setup_complete_body')}</p>
  <ul class="fl-setup-complete-facts">
    {#each facts as [icon, value, label] (label)}
      <li>
        <Icon {icon} size="18" aria-hidden={true} />
        <strong>{value.toLocaleString($locale)}</strong>
        <span>{label}</span>
      </li>
    {/each}
  </ul>
  {#if progress.flagged > 0}
    <a class="fl-setup-complete-flag" href={Route.libraryCare()} onclick={onClose}>
      <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
      {$t('setup_complete_flagged', { values: { count: progress.flagged } })}
      <Icon icon={mdiChevronRight} size="16" aria-hidden={true} />
    </a>
  {/if}
  <div class="fl-setup-complete-actions">
    <button type="button" class="button primary" data-initial-focus onclick={onClose}>
      {$t('setup_complete_start')}
    </button>
  </div>
</dialog>

<style>
  .fl-setup-complete {
    width: min(520px, calc(100vw - 32px));
    margin: auto;
    padding: 40px 40px 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, 10px);
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-2);
    text-align: center;
  }
  .fl-setup-complete::backdrop {
    background: color-mix(in srgb, var(--fl-canvas), transparent 30%);
  }
  .fl-setup-complete-mark {
    display: grid;
    place-items: center;
    width: 80px;
    height: 80px;
    margin: 0 auto 24px;
    border-radius: 999px;
    background: var(--fl-accent);
    color: var(--fl-accent-text, #072211);
    animation: fl-setup-complete-pop 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }
  h2 {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.6px;
  }
  p {
    max-width: 400px;
    margin: 12px auto 0;
    color: var(--fl-muted);
  }
  .fl-setup-complete-facts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 32px 0 0;
    padding: 0;
    list-style: none;
  }
  .fl-setup-complete-facts li {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: 16px 8px;
    border-radius: 6px;
    background: var(--fl-raised);
    color: var(--fl-accent);
  }
  .fl-setup-complete-facts strong {
    color: var(--fl-text);
    font-size: 20px;
    font-variant-numeric: tabular-nums;
  }
  .fl-setup-complete-facts span {
    color: var(--fl-muted);
    font-size: 12px;
  }
  .fl-setup-complete-flag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    margin-top: 24px;
    color: var(--fl-warning);
  }
  .fl-setup-complete-flag:hover {
    text-decoration: underline;
  }
  .fl-setup-complete-actions {
    display: flex;
    justify-content: center;
    margin-top: 24px;
  }
  .fl-setup-complete-actions .button {
    min-width: 200px;
    min-height: 44px;
  }
  @keyframes fl-setup-complete-pop {
    from {
      transform: scale(0.6);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-setup-complete-mark {
      animation: none;
    }
  }
  @media (max-width: 700px) {
    .fl-setup-complete {
      padding: 32px 16px 24px;
    }
    h2 {
      font-size: 24px;
    }
  }
</style>
