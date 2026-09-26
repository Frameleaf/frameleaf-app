<script lang="ts">
  /**
   * One Frameleaf Cloud settings card: the prototype's `Card` (FrameleafCloud.jsx:243-261), with an
   * optional icon tile, a title and description, and a status pill whose state is always written
   * out, never shown by colour alone. Styles come from cloud-account.css.
   */
  import { Icon } from '@immich/ui';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    description?: string;
    status?: string;
    tone?: 'muted' | 'ok' | 'warning' | 'danger' | 'running';
    icon?: string;
    children?: Snippet;
  };

  let { title, description, status, tone = 'muted', icon, children }: Props = $props();
  const titleId = $props.id();
</script>

<section class="fc-card fl-continuous-corners" aria-labelledby={titleId}>
  <div class="fc-card-title">
    {#if icon}
      <span class="fc-card-icon"><Icon {icon} size="18" /></span>
    {/if}
    <div>
      <h2 id={titleId}>{title}</h2>
      {#if description}
        <p>{description}</p>
      {/if}
    </div>
    {#if status}
      <span
        class="fc-status"
        class:is-ok={tone === 'ok'}
        class:is-warning={tone === 'warning'}
        class:is-danger={tone === 'danger'}
        class:is-running={tone === 'running'}>{status}</span
      >
    {/if}
  </div>
  {@render children?.()}
</section>
