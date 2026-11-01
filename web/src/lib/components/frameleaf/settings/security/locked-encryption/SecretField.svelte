<script lang="ts">
  /** FL-721: the PIN (six cells) or the passphrase (a text box) that proves it is you. */
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  let {
    kind,
    value = $bindable(''),
    label,
    disabled = false,
    autofocus = false,
  }: { kind: 'pin' | 'passphrase'; value?: string; label?: string; disabled?: boolean; autofocus?: boolean } = $props();

  const name = $derived(label ?? $t(kind === 'pin' ? 'frameleaf_le_locked_pin' : 'frameleaf_le_passphrase'));
</script>

{#if kind === 'pin'}
  <div class="le-label">
    <span>{name}</span>
    <PinCells bind:value {autofocus} label={name} {disabled} />
  </div>
{:else}
  <label>
    {name}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="le-text"
      type="password"
      autocomplete="current-password"
      maxlength={1024}
      aria-label={name}
      placeholder={$t('frameleaf_le_passphrase')}
      {autofocus}
      {disabled}
      bind:value
    />
  </label>
{/if}
