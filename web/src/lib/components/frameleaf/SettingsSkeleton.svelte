<script lang="ts">
  /**
   * Shown while Settings loads: the shape of the page, not a sentence (approved design, 2026-11-04,
   * App.jsx `SettingsSkeleton`). The root layout draws it under the top bar until the page arrives.
   */
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { t } from 'svelte-i18n';

  // The rail's links in their groups; 0 is the space between two groups.
  const rail = [70, 54, 62, 0, 58, 76, 66, 50, 72, 0, 64, 56, 70];
</script>

<div class="fl-settings-skeleton" role="status" aria-label={$t('frameleaf_settings_opening')}>
  <div class="rail" aria-hidden="true">
    {#each rail as width, index (index)}
      {#if width}<Skeleton variant="block" width="{width}%" height="12px" />{:else}<span class="gap"></span>{/if}
    {/each}
  </div>
  <div class="page" aria-hidden="true">
    <Skeleton variant="block" width="110px" height="10px" />
    <Skeleton variant="block" width="240px" height="28px" />
    <Skeleton variant="block" width="360px" height="12px" />
    <span class="card"><Skeleton variant="block" height="112px" /></span>
    <Skeleton variant="block" height="260px" />
  </div>
</div>

<style>
  .fl-settings-skeleton {
    position: fixed;
    inset: var(--fl-topbar-height) 0 0;
    z-index: var(--fl-z-rail);
    display: flex;
    background: var(--fl-canvas);
  }
  .rail {
    display: flex;
    flex-direction: column;
    flex: 0 0 280px;
    gap: 14px;
    padding: 22px 22px 0;
    border-inline-end: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .gap {
    height: 10px;
  }
  .page {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 14px;
    max-width: 980px;
    padding: 40px 48px;
  }
  .card {
    margin-top: 12px;
  }
  @media (max-width: 700px) {
    .fl-settings-skeleton {
      inset-block-start: var(--fl-topbar-height-phone);
    }
    .rail {
      display: none;
    }
    .page {
      padding: 24px 16px;
    }
  }
</style>
