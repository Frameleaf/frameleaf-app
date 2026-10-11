<script lang="ts">
  /**
   * The on/off control of a Row, saying "On" or "Off" beside it. `held` is a switch that cannot be
   * used right now: it keeps showing the saved choice, greyed, and the page says why beside it.
   */
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import { t } from 'svelte-i18n';

  let {
    label,
    checked,
    held = false,
    describedBy,
    onChange,
  }: {
    label: string;
    checked: boolean;
    held?: boolean;
    describedBy?: string;
    onChange?: (checked: boolean) => void;
  } = $props();
</script>

<Toggle
  {label}
  {checked}
  disabled={held}
  {describedBy}
  onLabel={$t('frameleaf_kit_on')}
  offLabel={$t('frameleaf_kit_off')}
  {onChange}
/>
