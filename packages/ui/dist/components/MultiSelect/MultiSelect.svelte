<script lang="ts" generics="T extends string">
  import InternalSelect from '../../internal/Select.svelte';
  import type { MultiSelectProps, SelectOption } from '../../types.js';

  let { onChange, onSelect, values = $bindable([]), ...restProps }: MultiSelectProps<T> = $props();

  const handleChange = (values: T[]) => {
    onChange?.(values);
  };

  const handleSelect = (items: SelectOption<T>[]) => {
    onSelect?.(items);
  };
</script>

<InternalSelect multiple bind:values onSelect={handleSelect} onChange={handleChange} {...restProps} />
