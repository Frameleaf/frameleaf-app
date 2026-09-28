<script lang="ts">
  const {
    label,
    description,
    checked,
    onchange,
  }: { label: string; description?: string; checked: boolean; onchange: (checked: boolean) => void } = $props();
  const id = $props.id();
</script>

<div class="fl-switch-row">
  <div>
    <strong id="{id}-label">{label}</strong>
    {#if description}<span id="{id}-description">{description}</span>{/if}
  </div>
  <button
    type="button"
    role="switch"
    class="fl-switch"
    aria-checked={checked}
    aria-labelledby="{id}-label"
    aria-describedby={description ? `${id}-description` : undefined}
    onclick={() => onchange(!checked)}
  ></button>
</div>
