<script lang="ts">
  /**
   * The on/off control of a Row, saying "On" or "Off" beside it. `held` is a switch that cannot be
   * used right now: it keeps showing the saved choice, greyed, and the page says why beside it.
   * `always` is a promise rather than a setting (the prototype kit's `disabled` Switch): on, never
   * changed, and saying "Always".
   */
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import { t } from 'svelte-i18n';

  let {
    label,
    checked,
    held = false,
    always = false,
    describedBy,
    onChange,
  }: {
    label: string;
    checked: boolean;
    held?: boolean;
    always?: boolean;
    describedBy?: string;
    onChange?: (checked: boolean) => void;
  } = $props();
</script>

<Toggle
  {label}
  checked={always || checked}
  disabled={always || held}
  {describedBy}
  onLabel={always ? $t('frameleaf_kit_always') : $t('frameleaf_kit_on')}
  offLabel={$t('frameleaf_kit_off')}
  {onChange}
/>
