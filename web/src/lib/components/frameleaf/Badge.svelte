<script lang="ts">
  /**
   * A small count or status marker. Colour never carries the meaning on its own: `label` is
   * the translated text a screen reader announces, and the visible `value` is hidden from
   * the accessibility tree so the two are never read twice. When the visible value is the label
   * itself (a status such as "Not verified"), it is rendered once.
   *
   * `accent` is reserved for counts attached to a primary or selection affordance; teal and
   * blue carry status, per the September 22 revision.
   */
  let {
    value,
    label,
    tone = 'accent',
  }: {
    /** Short visible content, usually a count. */
    value: string | number;
    /** Full translated meaning, for example "3 filters active". */
    label: string;
    tone?: 'accent' | 'teal' | 'blue' | 'warning' | 'danger' | 'neutral';
  } = $props();
</script>

<span class="badge {tone}">
  {#if String(value) === label}
    <!-- A status badge whose text already says it all is read once, not twice. -->
    {label}
  {:else}
    <span aria-hidden="true">{value}</span>
    <span class="sr-only">{label}</span>
  {/if}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.125rem;
    height: 1.125rem;
    padding-inline: 0.3125rem;
    /* The revision's floor: nothing below 11px. */
    font-size: var(--fl-font-micro);
    font-weight: 600;
    line-height: 1;
    border-radius: var(--fl-radius-pill);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .accent {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
  }
  .teal {
    color: var(--fl-teal-text);
    background: var(--fl-teal);
  }
  .blue {
    color: var(--fl-blue-text);
    background: var(--fl-blue);
  }
  .warning {
    color: var(--fl-warning-text);
    background: var(--fl-warning);
  }
  .danger {
    color: var(--fl-danger-text);
    background: var(--fl-danger);
  }
  .neutral {
    color: var(--fl-text);
    background: var(--fl-raised);
    box-shadow: inset 0 0 0 1px var(--fl-border);
  }
</style>
