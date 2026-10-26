<script lang="ts">
  /**
   * FL-516: how much space, as a short list with "Other…" for an exact amount in GB (see ./space.ts).
   * `value` is in decimal GB; null is no limit.
   */
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import { SPACE_SIZES_GB, spaceChoiceOf, spaceWords } from '$lib/components/frameleaf/settings/people/space';
  import { t } from 'svelte-i18n';

  let {
    label,
    value,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: number | null;
    disabled?: boolean;
    onChange: (value: number | null) => void;
  } = $props();

  /** "Other…" stays chosen while an exact amount is typed, even one that matches a listed size. */
  let other = $state(false);
  const choice = $derived(other ? 'other' : spaceChoiceOf(value));
  const options = $derived([
    { value: 'none', label: $t('frameleaf_userpage_space_none') },
    ...SPACE_SIZES_GB.map((gb) => ({ value: String(gb), label: spaceWords(gb) })),
    { value: 'other', label: $t('frameleaf_userpage_space_other') },
  ]);

  const choose = (next: string) => {
    other = next === 'other';
    if (next === 'none') {
      onChange(null);
    } else if (next !== 'other') {
      onChange(Number(next));
    } else if (value === null) {
      onChange(300);
    }
  };
</script>

<div class="space-picker">
  {#if choice === 'other'}
    <Amount
      label={$t('frameleaf_userpage_space_in_gb', { values: { label } })}
      unit="GB"
      min={1}
      max={1_000_000}
      value={Math.round(value ?? 300)}
      {disabled}
      onChange={(gb) => onChange(gb)}
    />
  {/if}
  <Select {label} value={choice} {options} {disabled} onChange={choose} />
</div>

<style>
  .space-picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
</style>
