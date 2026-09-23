<script lang="ts">
  /**
   * The Frameleaf auth/onboarding shell (FL-80).
   *
   * Restyles the card the legacy `AuthPageLayout` renders for every public/auth route
   * (login, register, forced password change, the PIN prompt, the maintenance splash) and
   * the onboarding card, without changing what any of them do: this component only ever
   * wraps children the route already produces from its own load function and form
   * handlers. It follows the same gating pattern as `LibraryRail`/`TopBar` (FL-30): callers
   * check `$frameleafShell` themselves and render this in place of the legacy layout, so
   * there is exactly one rollout flag for the whole shell rather than a second, auth-only
   * one.
   *
   * Theme follows the shell theme (`themeManager`), the same signal `LibraryRail`/`TopBar`
   * read, so a PIN prompt reached mid-session matches the rest of the app rather than
   * flashing to a default.
   */
  import FrameleafLogo from '$lib/components/frameleaf/Logo.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Icon, Theme as AppTheme, ThemePreference, ThemeSwitcher, themeManager } from '@immich/ui';
  import type { Snippet } from 'svelte';

  let {
    title,
    icon,
    withHeader = true,
    children,
    footer,
  }: {
    title?: string;
    icon?: string;
    withHeader?: boolean;
    children?: Snippet;
    footer?: Snippet;
  } = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<section class="frameleaf fl-auth-screen" data-theme={appTheme}>
  <div class="fl-auth-panel">
    <div class="fl-auth-top">
      <FrameleafLogo variant="inline" theme={appTheme} class="h-7" />
      {#if themeManager.preference !== ThemePreference.System}
        <ThemeSwitcher size="medium" color="secondary" />
      {/if}
    </div>

    <div class="fl-auth-body">
      {#if withHeader && (title || icon)}
        <div class="fl-auth-heading">
          {#if icon}
            <Icon {icon} size="30" />
          {/if}
          {#if title}
            <h1>{title}</h1>
          {/if}
        </div>
      {/if}
      {@render children?.()}
    </div>

    {#if footer}
      <footer class="fl-auth-foot">
        {@render footer()}
      </footer>
    {/if}
  </div>
</section>

<style>
  .fl-auth-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    min-width: 100dvw;
    padding: 1rem;
  }
  .fl-auth-panel {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    width: 100%;
    max-width: 30rem;
    padding: 2rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-dialog);
    box-shadow: var(--fl-shadow-2);
  }
  .fl-auth-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .fl-auth-body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .fl-auth-heading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-text);
    text-align: center;
  }
  .fl-auth-heading h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  .fl-auth-foot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    text-align: center;
  }
</style>
