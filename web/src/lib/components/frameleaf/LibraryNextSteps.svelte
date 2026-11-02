<script lang="ts">
  /**
   * The one-time "Next steps" card at the head of the library (design review finding 98). During
   * first-run setup the administrator is told that Library Care, Cloud backup and Background work come
   * after setup; this card is where they are, once, when the library first opens. It leaves on
   * "Dismiss" and is not shown again (`next-steps.svelte.ts`).
   *
   * Those three places are the server's, so only an administrator is offered the card.
   *
   * UI review 2026-10-30 #7 (prototype `NextStepsRow.jsx`): on phones the card is one row, so the
   * photos start on the first screen. The row names the card and how many suggestions it holds,
   * opens to the three of them, and dismisses the card for good like the card's own close button.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { dismissNextSteps, nextStepsOffered } from '$lib/components/timeline/next-steps.svelte';
  import { reveal } from '$lib/frameleaf/motion';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiChevronDown,
    mdiChevronRight,
    mdiClose,
    mdiCloudUploadOutline,
    mdiProgressClock,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { MediaQuery } from 'svelte/reactivity';

  const phone = new MediaQuery('max-width: 700px');
  let expanded = $state(false);

  const userId = $derived(authManager.authenticated && authManager.user.isAdmin ? authManager.user.id : undefined);
  const show = $derived(nextStepsOffered(userId));

  const steps = $derived([
    {
      id: 'care',
      href: Route.libraryCare(),
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_library_care'),
      body: $t('frameleaf_next_steps_care'),
    },
    {
      id: 'backup',
      href: commandCenterUrl('cloud', 'cloud-backup'),
      icon: mdiCloudUploadOutline,
      title: $t('frameleaf_next_steps_backup_title'),
      body: $t('frameleaf_next_steps_backup'),
    },
    {
      // Upload processing (thumbnails, faces, search, text) is queue work, which Activity doesn't list.
      id: 'background',
      href: commandCenterUrl('processing', 'queues'),
      icon: mdiProgressClock,
      title: $t('frameleaf_computers_page_queues'),
      body: $t('frameleaf_next_steps_activity'),
    },
  ]);
</script>

{#if show && userId && phone.current}
  <section class="fl-next-steps-row" aria-label={$t('frameleaf_next_steps_title')} data-testid="frameleaf-next-steps">
    <div class="fl-nsr-row">
      <button
        type="button"
        class="fl-nsr-main"
        aria-expanded={expanded}
        aria-controls="fl-next-steps-list"
        onclick={() => (expanded = !expanded)}
      >
        <Icon icon={mdiCheckCircleOutline} size="18" aria-hidden />
        <span class="fl-nsr-text">
          <strong>{$t('frameleaf_next_steps_title')}</strong> · {$t('frameleaf_next_steps_summary', {
            values: { count: steps.length },
          })}
        </span>
        <Icon icon={mdiChevronDown} size="16" aria-hidden class="fl-nsr-chevron" />
      </button>
      <IconButton label={$t('frameleaf_next_steps_dismiss')} onclick={() => dismissNextSteps(userId)}>
        <Icon icon={mdiClose} size="18" />
      </IconButton>
    </div>
    {#if expanded}
      <ul id="fl-next-steps-list" class="fl-nsr-list">
        {#each steps as step (step.id)}
          <li>
            <a href={step.href} data-step={step.id}>
              <Icon icon={step.icon} size="18" aria-hidden />
              <span class="fl-nsr-step">
                <strong>{step.title}</strong>
                <small>{step.body}</small>
              </span>
              <Icon icon={mdiChevronRight} size="16" aria-hidden />
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{:else if show && userId}
  <section
    class="fl-next-steps"
    aria-labelledby="fl-next-steps-title"
    data-testid="frameleaf-next-steps"
    in:reveal
    out:reveal
  >
    <header>
      <div>
        <h2 id="fl-next-steps-title">{$t('frameleaf_next_steps_title')}</h2>
        <p>{$t('frameleaf_next_steps_body')}</p>
      </div>
      <IconButton label={$t('frameleaf_next_steps_dismiss')} onclick={() => dismissNextSteps(userId)}>
        <Icon icon={mdiClose} size={ICON_SIZE.lg} />
      </IconButton>
    </header>
    <ul>
      {#each steps as step (step.id)}
        <li>
          <a class="fl-control" href={step.href} data-step={step.id}>
            <span class="fl-next-steps-icon" aria-hidden="true"><Icon icon={step.icon} size={ICON_SIZE.xl} /></span>
            <span class="fl-next-steps-text">
              <strong>{step.title}</strong>
              <span>{step.body}</span>
            </span>
            <Icon icon={mdiChevronRight} size={ICON_SIZE.lg} aria-hidden />
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .fl-next-steps {
    margin: var(--fl-space-3) 0 var(--fl-space-4);
    padding: var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fl-space-3);
    margin-bottom: var(--fl-space-3);
  }
  h2 {
    margin: 0;
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
  }
  header p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font: var(--fl-type-callout);
  }
  ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  a {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    height: 100%;
    min-height: var(--fl-control-height-touch);
    padding: var(--fl-space-3);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    text-decoration: none;
    transition: background-color var(--fl-motion-fast) var(--fl-ease);
  }
  a:hover {
    background: var(--fl-accent-soft);
  }
  a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .fl-next-steps-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--fl-accent);
  }
  .fl-next-steps-text {
    flex: 1;
    display: grid;
    gap: var(--fl-space-half);
    min-width: 0;
    font: var(--fl-type-callout);
  }
  .fl-next-steps-text strong {
    font-weight: 600;
  }
  .fl-next-steps-text span {
    color: var(--fl-muted);
  }
  a > :global(svg:last-child) {
    flex: 0 0 auto;
    color: var(--fl-muted);
  }
  :global([dir='rtl']) a > :global(svg:last-child) {
    scale: -1 1;
  }

  /* Phones: one row (review-1030-shell.css `.nsr`). */
  .fl-next-steps-row {
    margin: var(--fl-space-3) 0 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  .fl-nsr-row {
    display: flex;
    align-items: center;
  }
  .fl-nsr-main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
    min-height: 44px;
    padding: 0 var(--fl-space-3);
    border: 0;
    background: none;
    color: var(--fl-muted);
    font-size: 13px;
    text-align: start;
  }
  .fl-nsr-main > :global(svg:first-child) {
    flex: none;
    color: var(--fl-accent);
  }
  .fl-nsr-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-nsr-text strong {
    color: var(--fl-text);
    font-weight: 600;
  }
  .fl-nsr-main :global(.fl-nsr-chevron) {
    flex: none;
    transition: rotate var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-nsr-main[aria-expanded='true'] :global(.fl-nsr-chevron) {
    rotate: 180deg;
  }
  ul.fl-nsr-list {
    display: grid;
    gap: 0;
    padding: 0 var(--fl-space-2) var(--fl-space-2);
  }
  .fl-nsr-list a {
    gap: var(--fl-space-3);
    min-height: 44px;
    padding: var(--fl-space-2);
    background: none;
    color: var(--fl-muted);
  }
  .fl-nsr-list a > :global(svg:first-child) {
    flex: none;
    color: var(--fl-accent);
  }
  .fl-nsr-step {
    display: grid;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .fl-nsr-step strong {
    color: var(--fl-text);
    font-size: 13px;
    font-weight: 500;
  }
  .fl-nsr-step small {
    font-size: 12px;
  }
</style>
