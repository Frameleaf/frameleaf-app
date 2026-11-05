<script lang="ts">
  import { cleanClass } from '$lib';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageBrokenVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { ClassValue } from 'svelte/elements';

  interface Props {
    class?: ClassValue;
    hideMessage?: boolean;
    width?: string | undefined;
    height?: string | undefined;
  }

  let { class: className, hideMessage = false, width = undefined, height = undefined }: Props = $props();
</script>

<!--
  A quiet placeholder where an image cannot be shown (a RAW file without a preview yet, a file that
  failed to load): the tile's own dark fill and a small muted icon, so one missing preview does not
  shout over the photos around it. The words appear only where there is room to read them whole.
-->
<div
  data-broken-asset
  class={cleanClass('fl-broken-asset @container', className)}
  style:width
  style:height
  role="img"
  aria-label={$t('error_loading_image')}
>
  <Icon icon={mdiImageBrokenVariant} size="28" class="fl-broken-asset-icon" aria-hidden />
  {#if !hideMessage}
    <span class="fl-broken-asset-text" aria-hidden="true">{$t('error_loading_image')}</span>
  {/if}
</div>

<style>
  .fl-broken-asset {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2, 8px);
    max-width: 100%;
    max-height: 100%;
    overflow: hidden;
    padding: var(--fl-space-3, 12px);
    background: var(--fl-raised, rgb(127 127 127 / 0.12));
    color: var(--fl-muted, rgb(127 127 127));
  }
  .fl-broken-asset :global(.fl-broken-asset-icon) {
    flex: none;
    opacity: 0.7;
  }
  .fl-broken-asset-text {
    display: none;
    max-width: 100%;
    overflow: hidden;
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Only where the whole line fits: a narrow tile keeps the icon alone. */
  @container (min-width: 160px) {
    .fl-broken-asset-text {
      display: block;
    }
  }
  /* Too small even for the icon (a strip thumbnail): the fill alone. */
  @container (max-width: 40px) {
    .fl-broken-asset :global(.fl-broken-asset-icon) {
      display: none;
    }
  }
</style>
