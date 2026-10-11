<script lang="ts">
  /** The way back from a page opened from another one: "‹ Backup". */
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronLeft } from '@mdi/js';

  let { href, label }: { href: string; label: string } = $props();
</script>

<a class="kit-back" {href}>
  <Icon icon={mdiChevronLeft} size="18" aria-hidden />
  {label}
</a>

<style>
  .kit-back {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: var(--fl-space-1);
    min-height: 36px;
    padding: 0 var(--fl-space-3) 0 var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    text-decoration: none;
    border-radius: var(--fl-radius-control);
  }
  .kit-back:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .kit-back:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @media (pointer: coarse) {
    .kit-back {
      min-height: var(--fl-control-height);
    }
  }
</style>
