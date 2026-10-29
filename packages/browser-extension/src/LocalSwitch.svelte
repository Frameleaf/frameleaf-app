<script lang="ts">
  let {
    checked = $bindable(false),
    disabled = false,
  }: { checked?: boolean; disabled?: boolean } = $props();
</script>

<label class="switch">
  <span>
    <strong>Allow a local server without HTTPS</strong>
    <small
      >For a server on this computer only (localhost). Anywhere else needs
      HTTPS.</small
    >
  </span>
  <input type="checkbox" role="switch" bind:checked {disabled} />
</label>
