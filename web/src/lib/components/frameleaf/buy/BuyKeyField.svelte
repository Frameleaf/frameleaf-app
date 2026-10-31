<script lang="ts">
  /**
   * "Already have a key?" (AuthScreens.jsx:1763-1788, effd05ffb7; FL-171): the product key field.
   * It re-hyphenates into FL-XXXX-XXXX-XXXX as the person types, names the kind once a key checks
   * out (kind and mod-32 check symbol) and explains a mistake before anything is sent. The key is
   * only handed to the caller for a request body; it never enters an address.
   */
  import { normalizeProductKey, productKeyMessageKey, validateProductKey } from '$lib/frameleaf/cloud';
  import { t } from 'svelte-i18n';

  type Props = { value: string; error?: string };

  let { value = $bindable(''), error = '' }: Props = $props();
  const id = $props.id();

  const check = $derived(validateProductKey(value));
  const hint = $derived.by(() => {
    if (check.valid) {
      return check.kind === 'server'
        ? $t('frameleaf_buy_key_server_recognised')
        : $t('frameleaf_buy_key_individual_recognised');
    }
    if (value && (value.length >= 17 || check.reason === 'upstream')) {
      return $t(productKeyMessageKey(check.reason));
    }
    return $t('frameleaf_license_key_error_format');
  });
</script>

<div class="auth-field">
  <label for={id}>{$t('frameleaf_buy_key_label')}</label>
  <input
    {id}
    {value}
    autocomplete="off"
    spellcheck="false"
    placeholder="FL-XXXX-XXXX-XXXX"
    aria-invalid={error || (!check.valid && value.length >= 17) ? true : undefined}
    aria-describedby="{id}-hint"
    oninput={(event) => {
      const raw = event.currentTarget.value;
      value = /^\s*IM/i.test(raw) ? raw.toUpperCase() : normalizeProductKey(raw);
      event.currentTarget.value = value;
    }}
  />
  <span class="auth-field-hint" id="{id}-hint" aria-live="polite">{error || hint}</span>
</div>
