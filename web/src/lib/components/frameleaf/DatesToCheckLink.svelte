<script lang="ts">
  /**
   * "2 dates to check" beside a date range (FL-1410; the prototype's `.ch-dates-check`, messy-1110.css
   * M4): the range of an album, a tag or a folder leaves out the photos whose date cannot be right,
   * and this says how many there are and goes to where they are fixed.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiCalendarAlert } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { count, onclick }: { count: number; onclick: () => void } = $props();
</script>

<button type="button" class="fl-dates-check" data-testid="frameleaf-dates-to-check" {onclick}>
  <Icon icon={mdiCalendarAlert} size="14" aria-hidden />
  {$t('frameleaf_dates_to_check_count', { values: { count } })}
</button>

<style>
  .fl-dates-check {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    /* It sits in a line of text: its 44px target (48px on touch) is an invisible box centred on it. */
    min-height: 0;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--fl-warning);
    font: inherit;
    cursor: pointer;
  }
  .fl-dates-check::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    inset-block: min(0px, calc((100% - 44px) / 2));
  }
  @media (pointer: coarse) {
    .fl-dates-check {
      min-height: 0;
    }
    .fl-dates-check::after {
      inset-block: min(0px, calc((100% - 48px) / 2));
    }
  }
  .fl-dates-check:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .fl-dates-check:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
