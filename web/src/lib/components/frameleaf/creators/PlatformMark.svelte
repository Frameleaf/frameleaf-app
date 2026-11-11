<script lang="ts">
  import { Icon } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import { CREATOR_PLATFORMS, platformName } from '$lib/frameleaf/creators';
  import type { MediaPlatform } from '$lib/frameleaf/media-address';

  /** The small mark of the site a creator is on (prototype `PlatformMark`). */
  let {
    platform,
    provider,
    size = 14,
  }: { platform: MediaPlatform; provider?: string | null; size?: number } = $props();
  const mark = $derived(CREATOR_PLATFORMS[platform]);
  const name = $derived(platformName(platform, provider) || $t('frameleaf_creators_platform_website'));
</script>

<span class="cr-mark" title={name} aria-label={name} role="img">
  {#if mark.icon}
    <Icon icon={mark.icon} size="{size}px" aria-hidden={true} />
  {:else}
    <span aria-hidden="true">{mark.letter}</span>
  {/if}
</span>

<style>
  .cr-mark {
    display: inline-grid;
    place-items: center;
    flex: none;
    min-width: 16px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1;
    vertical-align: -2px;
  }
</style>
