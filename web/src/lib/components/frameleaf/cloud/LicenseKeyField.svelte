<script lang="ts">
  /**
   * The licence key input (FL-171): the prototype's key field (FrameleafCloud.jsx:1131-1144,
   * AuthScreens.jsx "Already have a key?"). It re-hyphenates as the person types into
   * FL-XXXX-XXXX-XXXX and checks the kind and mod-32 check symbol before anything is sent. The key
   * is only ever handed to the caller, never put in an address.
   */
  import {
    normalizeProductKey,
    productKeyMessageKey,
    validateProductKey,
    type ProductKeyCheck,
  } from '$lib/frameleaf/cloud';
  import { t } from 'svelte-i18n';

  type Props = {
    value: string;
    label: string;
    help?: string;
    /** The kind this field accepts; a key of the other kind is refused with its own message. */
    accept?: 'server' | 'individual' | 'any';
    onCheck?: (check: ProductKeyCheck) => void;
  };

  let { value = $bindable(''), label, help, accept = 'any', onCheck }: Props = $props();
  const id = $props.id();

  const check = $derived.by((): ProductKeyCheck => validateProductKey(value));
  const wrongKind = $derived(check.valid && accept !== 'any' && check.kind !== accept);
  // show a problem once the person has typed a whole key, or a key of the previous scheme
  const complete = $derived(value.length >= 17 || (!check.valid && check.reason === 'upstream'));
  const message = $derived(
    wrongKind
      ? $t(accept === 'server' ? 'frameleaf_license_key_error_personal' : 'frameleaf_license_key_error_server')
      : !check.valid && value && complete
        ? $t(productKeyMessageKey(check.reason))
        : '',
  );

  $effect(() => {
    onCheck?.(wrongKind ? { valid: false, key: check.key, reason: 'kind' } : check);
  });
</script>

<div class="fc-field">
  <div>
    <label for={id}>{label}</label>
    {#if help}
      <p id="{id}-help">{help}</p>
    {/if}
  </div>
  <div>
    <input
      {id}
      class="fc-input"
      {value}
      autocomplete="off"
      spellcheck="false"
      placeholder="FL-XXXX-XXXX-XXXX"
      aria-invalid={message ? true : undefined}
      aria-describedby={help ? `${id}-help` : undefined}
      oninput={(event) => {
        const raw = event.currentTarget.value;
        value = /^\s*IM/i.test(raw) ? raw.toUpperCase() : normalizeProductKey(raw);
        event.currentTarget.value = value;
      }}
    />
    {#if message}
      <small class="fc-error" role="alert">{message}</small>
    {/if}
  </div>
</div>
