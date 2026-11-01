<script lang="ts">
  /**
   * FL-721 (prototype `TurnOn` passphrase step): a new passphrase, its strength bar, and the same
   * passphrase again. The caller sends it once `passphraseReady` says it can.
   */
  import { passphraseStrength, PASSPHRASE_MIN_LENGTH } from '$lib/frameleaf/locked-encryption';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  let {
    phrase = $bindable(''),
    again = $bindable(''),
    disabled = false,
  }: { phrase?: string; again?: string; disabled?: boolean } = $props();

  const strength = $derived(passphraseStrength(phrase));
  const mismatch = $derived(again.length >= phrase.length && again.length > 0 && again !== phrase);
  const words = $derived(
    strength === 'none'
      ? $t('frameleaf_le_strength_none')
      : strength === 'weak'
        ? $t('frameleaf_le_strength_weak', { values: { count: PASSPHRASE_MIN_LENGTH - phrase.length } })
        : strength === 'great'
          ? $t('frameleaf_le_strength_great')
          : $t('frameleaf_le_strength_good'),
  );
</script>

<label>
  {$t('frameleaf_le_passphrase')}
  <input
    class="le-text"
    type="password"
    autocomplete="new-password"
    maxlength={1024}
    aria-label={$t('frameleaf_le_passphrase')}
    placeholder={$t('frameleaf_le_passphrase_placeholder')}
    {disabled}
    bind:value={phrase}
  />
  <span class="le-strength" data-strength={strength}>
    <span></span>
    <small aria-live="polite">{words}</small>
  </span>
</label>
<label>
  {$t('frameleaf_le_passphrase_again')}
  <input
    class="le-text"
    type="password"
    autocomplete="new-password"
    maxlength={1024}
    aria-label={$t('frameleaf_le_passphrase_again_label')}
    aria-invalid={mismatch || undefined}
    {disabled}
    bind:value={again}
  />
</label>
{#if mismatch}
  <p class="le-error" role="alert">{$t('frameleaf_le_passphrase_mismatch')}</p>
{/if}
