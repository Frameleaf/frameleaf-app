<script lang="ts">
  import FrameleafLogo from '$lib/components/frameleaf/Logo.svelte';
  import summit from '$lib/assets/frameleaf/auth-summit.webp';
  import cabin from '$lib/assets/frameleaf/auth-cabin.webp';
  import '$lib/frameleaf/tokens.css';
  import '$lib/frameleaf/auth.css';
  import { mdiMoonWaningCrescent, mdiWhiteBalanceSunny } from '@mdi/js';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    withHeader = true,
    children,
    footer,
    hero,
    attribution = false,
    keypad = 'auto',
  }: {
    title?: string;
    withHeader?: boolean;
    children?: Snippet;
    footer?: Snippet;
    hero?: 'summit' | 'cabin';
    attribution?: boolean;
    keypad?: 'auto' | 'always' | 'never';
  } = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const heroImage = $derived(hero === 'summit' ? summit : cabin);
  const heroTitle = $derived(
    hero === 'summit' ? $t('frameleaf_auth_hero_summit_title') : $t('frameleaf_auth_hero_cabin_title'),
  );
  const heroSubtitle = $derived(
    hero === 'summit' ? $t('frameleaf_auth_hero_summit_place') : $t('frameleaf_auth_hero_cabin_place'),
  );
</script>

<section
  class="frameleaf auth-screen"
  class:split={!!hero}
  class:single={!hero}
  data-theme={appTheme}
  data-keypad={keypad}
>
  <div class="auth-pane">
    <div class="auth-pane-top">
      <div class="auth-brand-plate">
        <FrameleafLogo variant="inline" theme="dark" />
      </div>
      <button
        type="button"
        class="button auth-theme-toggle"
        aria-label={appTheme === 'dark' ? $t('frameleaf_auth_switch_to_light') : $t('frameleaf_auth_switch_to_dark')}
        onclick={() => themeManager.toggle()}
      >
        <Icon icon={appTheme === 'dark' ? mdiWhiteBalanceSunny : mdiMoonWaningCrescent} size="20" />
      </button>
    </div>

    <div class="auth-pane-body">
      {#if withHeader && title}
        <div class="auth-heading"><h1>{title}</h1></div>
      {/if}
      {@render children?.()}
    </div>

    {#if footer || attribution}
      <footer class="auth-foot">
        {#if attribution}
          <span
            >{$t('frameleaf_auth_built_on')}
            <a href="https://immich.app" target="_blank" rel="noreferrer">Immich</a></span
          >
        {/if}
        {#if footer}{@render footer()}{/if}
      </footer>
    {/if}
  </div>

  {#if hero}
    <figure class="auth-hero" aria-hidden="true">
      <img src={heroImage} alt="" />
      <figcaption><strong>{heroTitle}</strong><span>{heroSubtitle}</span></figcaption>
    </figure>
  {/if}
</section>
