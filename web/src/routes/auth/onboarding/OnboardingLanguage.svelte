<script lang="ts">
  /**
   * Onboarding → Choose your language (FL-80 ON-1, O-13): the prototype's radio list of languages
   * (`AuthScreens.jsx:918-933`) over every language Frameleaf ships, in place of the upstream
   * Combobox. Choosing one applies it at once, as the App settings language choice does.
   */
  import { invalidateAll } from '$app/navigation';
  import { lang } from '$lib/stores/preferences.store';
  import { convertBCP47, getClosestAvailableLocale, langCodes, langs } from '$lib/utils/i18n';
  import { locale as i18nLocale, t } from 'svelte-i18n';

  const name = $props.id();
  const options = langs.map((entry) => ({ label: entry.name, value: convertBCP47(entry.code) }));
  const selected = $derived(getClosestAvailableLocale([$lang], langCodes));

  const choose = async (value: string) => {
    $lang = value;
    await i18nLocale.set(convertBCP47(value));
    await invalidateAll();
  };
</script>

<p>{$t('onboarding_locale_description')}</p>
<div class="ob-options" role="radiogroup" aria-label={$t('language')}>
  {#each options as option (option.value)}
    <label class="ob-option">
      <input
        type="radio"
        {name}
        value={option.value}
        checked={selected === option.value}
        onchange={() => choose(option.value)}
      />
      <span class="ob-radio" aria-hidden="true"></span>
      <span>{option.label}</span>
    </label>
  {/each}
</div>
