<script lang="ts">
  /**
   * A Frameleaf Cloud banner (FrameleafCloud.jsx:344-355): a coloured edge, an icon, a title and one
   * sentence, with an optional action. Danger banners are alerts; the others are polite status.
   */
  import { Icon } from '@immich/ui';
  import { mdiAlertOutline, mdiInformationOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';

  type Props = {
    tone?: 'info' | 'warning' | 'danger';
    icon?: string;
    title?: string;
    children: Snippet;
    action?: Snippet;
  };

  let { tone = 'info', icon, title, children, action }: Props = $props();
</script>

<div
  class="fc-banner"
  class:is-info={tone === 'info'}
  class:is-warning={tone === 'warning'}
  class:is-danger={tone === 'danger'}
  role={tone === 'danger' ? 'alert' : 'status'}
>
  <Icon icon={icon ?? (tone === 'info' ? mdiInformationOutline : mdiAlertOutline)} size="18" />
  <div>
    {#if title}
      <strong>{title}</strong>
    {/if}
    <p>{@render children()}</p>
  </div>
  {@render action?.()}
</div>
