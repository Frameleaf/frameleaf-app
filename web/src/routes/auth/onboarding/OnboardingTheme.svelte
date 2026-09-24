<script lang="ts">
  /**
   * Onboarding → Pick a theme (FL-80 ON-1, O-7): the prototype's three preview cards — Dark, Light and
   * Match system (`AuthScreens.jsx:934-958`, `ThemePreview` 785-801) — applied at once through the
   * theme manager, as the two upstream buttons did.
   */
  import { themeManager, ThemePreference } from '@immich/ui';
  import { t } from 'svelte-i18n';

  const name = $props.id();
  const choices = [
    { value: ThemePreference.Dark, mode: 'dark', label: 'dark', hint: 'frameleaf_onboarding_theme_dark_hint' },
    { value: ThemePreference.Light, mode: 'light', label: 'light', hint: 'frameleaf_onboarding_theme_light_hint' },
    {
      value: ThemePreference.System,
      mode: 'system',
      label: 'frameleaf_onboarding_theme_system',
      hint: 'frameleaf_onboarding_theme_system_hint',
    },
  ] as const;
</script>

<p>{$t('onboarding_theme_description')}</p>
<div class="ob-theme-cards" role="radiogroup" aria-label={$t('theme')}>
  {#each choices as choice (choice.value)}
    <label class="ob-theme-card">
      <input
        type="radio"
        {name}
        value={choice.value}
        checked={themeManager.preference === choice.value}
        onchange={() => themeManager.setPreference(choice.value)}
      />
      <div class="theme-preview {choice.mode}" aria-hidden="true">
        <div class="tp-bar"><i></i><i></i><i></i></div>
        <div class="tp-side"></div>
        <div class="tp-grid">
          {#each Array.from({ length: 8 }, (_, i) => i) as i (i)}<i></i>{/each}
        </div>
      </div>
      <span>
        {$t(choice.label)}
        <small>{$t(choice.hint)}</small>
      </span>
    </label>
  {/each}
</div>
