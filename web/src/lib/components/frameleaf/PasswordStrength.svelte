<script lang="ts">
  /**
   * The prototype's password strength meter and requirements checklist (`StrengthMeter` and
   * `Checklist` in AuthScreens.jsx), shown under a new-password field.
   */
  import { PASSWORD_RULES, passwordStrength } from '$lib/frameleaf/password-strength';
  import { Icon } from '@immich/ui';
  import { mdiCheckCircle, mdiCircleOutline } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  let { password = '' }: { password?: string } = $props();

  const strength = $derived(passwordStrength(password));
</script>

<div class="strength" data-score={strength.score}>
  <div class="bars" aria-hidden="true">
    <span></span>
    <span></span>
    <span></span>
    <span></span>
  </div>
  <div class="label">
    <span>{$t('frameleaf_password_strength')}</span>
    <span aria-live="polite">{$t(strength.labelKey as Translations)}</span>
  </div>
</div>
<ul class="checks" aria-label={$t('frameleaf_password_requirements')}>
  {#each PASSWORD_RULES as rule (rule.id)}
    {@const met = strength.checks[rule.id]}
    <li class:met>
      <Icon icon={met ? mdiCheckCircle : mdiCircleOutline} size="16" aria-hidden="true" />
      <span>{$t(rule.labelKey as Translations)}</span>
      <span class="sr-only">{met ? $t('frameleaf_password_rule_met') : $t('frameleaf_password_rule_not_met')}</span>
    </li>
  {/each}
</ul>

<style>
  .strength {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .bars {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
  }
  .bars span {
    height: 4px;
    border-radius: 2px;
    background: var(--fl-border);
  }
  .strength[data-score='1'] .bars span:nth-child(-n + 1),
  .strength[data-score='2'] .bars span:nth-child(-n + 2),
  .strength[data-score='3'] .bars span:nth-child(-n + 3),
  .strength[data-score='4'] .bars span:nth-child(-n + 4) {
    background: var(--fl-accent);
  }
  .strength[data-score='1'] .bars span:nth-child(-n + 1) {
    background: var(--fl-danger);
  }
  .label {
    display: flex;
    justify-content: space-between;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .checks {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .checks li {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .checks li.met {
    color: var(--fl-text);
  }
</style>
