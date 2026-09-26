<script lang="ts">
  import { passwordRequirements, passwordStrength } from '$lib/frameleaf/auth-password';
  import { mdiCheckCircle, mdiCircleOutline } from '@mdi/js';
  import { Icon } from '@immich/ui';
  import { t } from 'svelte-i18n';

  // Advisory only: the server decides which passwords it accepts.
  let { password, id }: { password: string; id?: string } = $props();
  const strength = $derived(passwordStrength(password));
</script>

<div {id} class="auth-strength" data-score={strength.score}>
  <div class="auth-strength-bars" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  <div class="auth-strength-label">
    <span>{$t('frameleaf_auth_password_strength')}</span><span aria-live="polite">{$t(strength.label)}</span>
  </div>
</div>
<ul class="auth-checks" aria-label={$t('frameleaf_auth_password_requirements')}>
  {#each passwordRequirements as rule (rule.id)}
    <li class:met={strength.checks[rule.id]}>
      <Icon icon={strength.checks[rule.id] ? mdiCheckCircle : mdiCircleOutline} size="16" />
      <span>{$t(rule.label)}</span><span class="sr-only"
        >, {strength.checks[rule.id]
          ? $t('frameleaf_auth_password_requirement_met')
          : $t('frameleaf_auth_password_requirement_not_met')}</span
      >
    </li>
  {/each}
</ul>
