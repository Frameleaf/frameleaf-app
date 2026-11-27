<script lang="ts">
  /**
   * Rows that stand in for a list while it loads (FL-1810, prototype `ListSkeleton`): the height of
   * the rows that replace them, so nothing jumps. Never "Loading…" text or a spinner.
   */
  import { t } from 'svelte-i18n';

  let {
    rows = 3,
    avatar = true,
  }: { rows?: number; /** Rows that start with a picture or an icon. */ avatar?: boolean } = $props();

  const items = $derived(Array.from({ length: Math.max(1, Math.floor(rows)) }, (_, index) => index));
</script>

<ul class="fl-skeleton-list" aria-busy="true" aria-label={$t('loading')} data-testid="frameleaf-list-skeleton">
  {#each items as index (index)}
    <li aria-hidden="true">
      {#if avatar}<span class="fl-skeleton avatar"></span>{/if}
      <span class="lines">
        <span class="fl-skeleton" style:width="{Math.max(30, 62 - index * 9)}%"></span>
        <span class="fl-skeleton" style:width="{Math.max(20, 38 - index * 5)}%"></span>
      </span>
    </li>
  {/each}
</ul>

<style>
  /* FL-1810: the placeholder carries its own look, so it shows in portalled surfaces outside
     .frameleaf too (the photo viewer's info panel, the font viewer); base.css keeps the same rule. */
  .fl-skeleton {
    display: block;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
    animation: fl-skeleton-pulse var(--fl-duration-pulse) var(--fl-ease) infinite alternate;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-skeleton {
      animation: none;
    }
  }
  ul {
    display: grid;
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 44px;
  }
  .avatar {
    flex: none;
    width: var(--fl-space-10);
    height: var(--fl-space-10);
    border-radius: var(--fl-radius-card);
  }
  .lines {
    display: grid;
    gap: var(--fl-space-2);
    flex: 1;
  }
  .lines .fl-skeleton {
    height: var(--fl-space-3);
  }
</style>
