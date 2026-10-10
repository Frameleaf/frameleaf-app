<script lang="ts">
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import summit from '$lib/assets/frameleaf/auth-summit.webp';
  import cabin from '$lib/assets/frameleaf/auth-cabin.webp';
  import '$lib/frameleaf/tokens.css';
  import '$lib/frameleaf/auth.css';
  import { mdiMoonWaningCrescent, mdiWhiteBalanceSunny } from '@mdi/js';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { DURATION } from '$lib/frameleaf/tokens';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    withHeader = true,
    children,
    footer,
    hero,
    keypad = 'auto',
    wide = false,
    arrive = false,
  }: {
    title?: string;
    withHeader?: boolean;
    children?: Snippet;
    footer?: Snippet;
    hero?: 'summit' | 'cabin';
    keypad?: 'auto' | 'always' | 'never';
    /** The prototype's `AuthShell wide` (onboarding): a wider single pane. */
    wide?: boolean;
    /**
     * The lockup fades in once as the page appears. For the screen where Frameleaf introduces
     * itself (sign-in) only; the PIN, password and maintenance screens are seen too often, or at
     * the wrong moment, for it.
     */
    arrive?: boolean;
  } = $props();

  // The entrance (auth.css): the photograph settles and the heading and card rise once. The
  // attribute goes afterwards, so later changes inside the pane never replay it.
  let entering = $state(true);
  onMount(() => {
    const timer = setTimeout(() => (entering = false), DURATION.hero + DURATION.sheet);
    return () => clearTimeout(timer);
  });

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
  class:wide
  data-theme={appTheme}
  data-keypad={keypad}
  data-entering={entering || undefined}
>
  <div class="auth-pane">
    <div class="auth-pane-top">
      <span class="auth-brand"><Brand surface={appTheme} size="tiny" {arrive} /></span>
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

    {#if footer}
      <!-- FL-190: no upstream attribution here; it lives on the About screen only. -->
      <footer class="auth-foot">{@render footer()}</footer>
    {/if}
  </div>

  {#if hero}
    <figure class="auth-hero" aria-hidden="true">
      <img src={heroImage} alt="" />
      <figcaption><strong>{heroTitle}</strong><span>{heroSubtitle}</span></figcaption>
    </figure>
  {/if}
</section>
