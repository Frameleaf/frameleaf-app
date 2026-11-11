<script lang="ts">
  /** FL-831: "Your password — To show it's you." in a two-step dialog. */
  import { t } from 'svelte-i18n';

  let { value = $bindable(''), invalid = false }: { value?: string; invalid?: boolean } = $props();
</script>

<label class="ts-field">
  {$t('frameleaf_two_step_password')}
  <small>{$t('frameleaf_two_step_password_hint')}</small>
  <input
    type="password"
    autocomplete="current-password"
    data-initial-focus=""
    aria-invalid={invalid || undefined}
    bind:value
  />
</label>
