<script lang="ts">
  /**
   * FL-936: how exact a date is, the one control at the top of both date dialogs (prototype
   * `PrecisionChoice`, `.fa-precision`): Exact date, Year, Decade. A radio group of real radios, so the
   * arrow keys move between the three and Tab passes it as one stop.
   */
  import type { DatePrecision } from '$lib/frameleaf/approximate-date';
  import { t } from 'svelte-i18n';

  let {
    value,
    onChange,
  }: {
    value: DatePrecision;
    onChange: (value: DatePrecision) => void;
  } = $props();

  const name = $props.id();
  const choices = $derived<{ value: DatePrecision; label: string }[]>([
    { value: 'exact', label: $t('frameleaf_date_precision_exact') },
    { value: 'year', label: $t('frameleaf_date_precision_year') },
    { value: 'decade', label: $t('frameleaf_date_precision_decade') },
  ]);
</script>

<div class="fl-precision" role="radiogroup" aria-label={$t('frameleaf_date_precision_label')}>
  {#each choices as choice (choice.value)}
    <label>
      <input
        type="radio"
        {name}
        value={choice.value}
        checked={choice.value === value}
        onchange={() => onChange(choice.value)}
      />
      <span>{choice.label}</span>
    </label>
  {/each}
</div>

<style>
  .fl-precision {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
  }

  .fl-precision label {
    position: relative;
    display: block;
    margin: 0;
    min-width: 0;
    cursor: pointer;
  }

  /* The radio itself is kept for the keyboard and for screen readers; the label's text is what shows. */
  .fl-precision input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    margin: 0;
    padding: 0;
    border: 0;
    opacity: 0;
    cursor: pointer;
  }

  .fl-precision span {
    display: grid;
    place-items: center;
    min-height: 32px;
    padding: 0 8px;
    border-radius: calc(var(--fl-radius-control) - 2px);
    color: var(--fl-muted);
    font-size: var(--fl-font-size);
    text-align: center;
  }

  .fl-precision input:checked + span {
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: 600;
    box-shadow: var(--fl-shadow-1);
  }

  .fl-precision input:focus-visible + span {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }

  @media (pointer: coarse) {
    .fl-precision span {
      min-height: 40px;
    }
  }
</style>
