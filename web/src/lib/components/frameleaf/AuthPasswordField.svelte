<script lang="ts">
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { Icon } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { HTMLInputAttributes } from 'svelte/elements';

  let {
    id,
    label,
    value = $bindable(''),
    autocomplete = 'new-password',
    autofocus = false,
    invalid = false,
    describedBy,
  }: {
    id: string;
    label: string;
    value?: string;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    autofocus?: boolean;
    invalid?: boolean;
    describedBy?: string;
  } = $props();
  let visible = $state(false);
</script>

<div class="auth-field">
  <label for={id}>{label}</label>
  <span class="auth-password">
    <!-- svelte-ignore a11y_autofocus (first field of the dedicated auth screen) -->
    <input
      {id}
      type={visible ? 'text' : 'password'}
      bind:value
      {autocomplete}
      {autofocus}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    />
    <button
      type="button"
      aria-label={visible ? $t('frameleaf_auth_hide_password') : $t('frameleaf_auth_show_password')}
      aria-pressed={visible}
      onclick={() => (visible = !visible)}
    >
      <Icon icon={visible ? mdiEyeOffOutline : mdiEyeOutline} size="18" />
    </button>
  </span>
</div>
