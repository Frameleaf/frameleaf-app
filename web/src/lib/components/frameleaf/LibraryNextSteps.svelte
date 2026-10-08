<script lang="ts">
  /**
   * The one-time "Next steps" card at the head of the library (design review finding 98). During
   * first-run setup the administrator is told that Library Care, Cloud backup and Activity come
   * after setup; this card is where they are, once, when the library first opens. It leaves on
   * "Dismiss" and is not shown again (`next-steps.svelte.ts`).
   *
   * Those three places are the server's, so only an administrator is offered the card.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { dismissNextSteps, nextStepsOffered } from '$lib/components/timeline/next-steps.svelte';
  import { reveal } from '$lib/frameleaf/motion';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiClose, mdiCloudUploadOutline, mdiProgressClock, mdiShieldCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

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
      id: 'activity',
      href: Route.activity(),
      icon: mdiProgressClock,
      title: $t('activity'),
      body: $t('frameleaf_next_steps_activity'),
    },
  ]);
</script>

{#if show && userId}
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
</style>
