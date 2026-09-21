<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  let {
    label,
    options,
    selectedOption = $bindable(),
    disabled = false,
    onSelect,
  }: {
    label: string;
    options: ComboBoxOption[];
    selectedOption?: ComboBoxOption;
    disabled?: boolean;
    onSelect?: (option: ComboBoxOption | undefined) => void;
  } = $props();
</script>

<Combobox {label} {options} bind:selectedOption {disabled} {onSelect} />
