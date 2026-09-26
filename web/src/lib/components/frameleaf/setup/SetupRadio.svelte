<script lang="ts">
  import SetupRecommended from '$lib/components/frameleaf/setup/SetupRecommended.svelte';

  type Props = {
    name: string;
    value: string;
    checked: boolean;
    onchange: (value: string) => void;
    title: string;
    detail?: string;
    recommended?: boolean;
  };
  const { name, value, checked, onchange, title, detail, recommended }: Props = $props();
</script>

<label class="frs-radio" class:checked>
  <input type="radio" {name} {value} {checked} onchange={() => onchange(value)} />
  <span class="frs-radio-dot" aria-hidden="true"></span>
  <span>
    <strong
      >{title}
      {#if recommended}<SetupRecommended />{/if}</strong
    >
    {#if detail}<small>{detail}</small>{/if}
  </span>
</label>
