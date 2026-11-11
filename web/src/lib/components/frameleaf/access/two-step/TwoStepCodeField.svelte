<script lang="ts">
  /** FL-831: a 6-digit code (or a recovery code) in a settings dialog; spaces and dashes from a paste go. */
  import { CODE_LENGTH, cleanCode, cleanRecoveryCode } from '$lib/frameleaf/two-step';
  import { t } from 'svelte-i18n';

  let {
    value = $bindable(''),
    recovery = false,
    invalid = false,
    describedBy,
    autofocus = false,
    label,
  }: {
    value?: string;
    recovery?: boolean;
    invalid?: boolean;
    describedBy?: string;
    autofocus?: boolean;
    label?: string;
  } = $props();

  const onInput = (event: Event & { currentTarget: HTMLInputElement }) => {
    value = recovery ? cleanRecoveryCode(event.currentTarget.value) : cleanCode(event.currentTarget.value);
    event.currentTarget.value = value;
  };
</script>

<label class="ts-field">
  {label ?? (recovery ? $t('frameleaf_two_step_recovery_label') : $t('frameleaf_two_step_app_code_label'))}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="ts-code"
    class:is-recovery={recovery}
    inputmode={recovery ? 'text' : 'numeric'}
    autocomplete={recovery ? 'off' : 'one-time-code'}
    autocapitalize="none"
    spellcheck={false}
    maxlength={recovery ? 11 : CODE_LENGTH + 2}
    placeholder={recovery ? 'xxxxx-xxxxx' : '000000'}
    {autofocus}
    data-initial-focus={autofocus ? '' : undefined}
    {value}
    aria-invalid={invalid || undefined}
    aria-describedby={describedBy}
    oninput={onInput}
  />
</label>
