<script lang="ts">
  /**
   * The heading of a settings page that draws its own (Users, one person, Libraries, Add a folder):
   * the same overline, title and description as the settings host's `.cc-page-heading`, then the
   * prototype's "‹ Back" (`settings-v2/kit.jsx` Page) 24px above the page's first card.
   */
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import type { Snippet } from 'svelte';

  let {
    overline,
    title,
    description,
    back,
    actions,
  }: {
    overline: string;
    title: string;
    description?: string;
    back?: { href: string; label: string };
    actions?: Snippet;
  } = $props();
</script>

<header class="kit-page-heading">
  <div>
    <SettingsOverline>{overline}</SettingsOverline>
    <h1>{title}</h1>
    {#if description}<p>{description}</p>{/if}
  </div>
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</header>
{#if back}
  <div class="back"><BackLink href={back.href} label={back.label} /></div>
{/if}

<style>
  /* SettingsHost `.cc-page-heading`. */
  .kit-page-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fl-space-4);
    margin-bottom: 22px;
  }
  .kit-page-heading > div:first-child {
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--fl-font-display);
    font-weight: 600;
    letter-spacing: -0.9px;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  p {
    max-width: 72ch;
    margin: 6px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  @media (max-width: 1000px) {
    h1 {
      font-size: 24px;
    }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  /* SettingsHost `.cc-back-to-area`. */
  .back {
    margin-bottom: var(--fl-space-6);
  }
</style>
