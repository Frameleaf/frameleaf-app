<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import { Button, Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiArrowLeft, mdiArrowRight, mdiCheck } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  interface Props {
    title?: string | undefined;
    icon?: string | undefined;
    children?: Snippet;
    previousTitle?: string | undefined;
    nextTitle?: string | undefined;
    onNext?: () => void;
    onPrevious?: () => void;
    onLeave?: () => void;
  }

  let {
    title = undefined,
    icon = undefined,
    children,
    previousTitle,
    nextTitle,
    onLeave,
    onNext,
    onPrevious,
  }: Props = $props();

  // Frameleaf onboarding card (FL-80): the styling only; every step's own content and
  // the next/previous contract below are unchanged.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<div
  id="onboarding-card"
  class="frameleaf fl-onboarding-card flex w-full max-w-4xl flex-col gap-4 p-8"
  data-theme={appTheme}
  in:fade={{ duration: 250 }}
>
  {#if title || icon}
    <div class="flex w-fit items-center justify-center gap-2">
      {#if icon}
        <Icon {icon} size="30" class="text-primary" />
      {/if}
      {#if title}
        <p class="text-xl font-medium text-primary">
          {title}
        </p>
      {/if}
    </div>
  {/if}
  {@render children?.()}

  <div class="flex pt-4">
    {#if previousTitle}
      <div class="flex w-full place-content-start">
        <Button
          shape="round"
          leadingIcon={languageManager.rtl ? mdiArrowRight : mdiArrowLeft}
          class="flex place-content-center gap-2"
          onclick={() => {
            onLeave?.();
            onPrevious?.();
          }}
        >
          <p>{previousTitle}</p>
        </Button>
      </div>
    {/if}

    <div class="flex w-full place-content-end">
      <Button
        shape="round"
        trailingIcon={nextTitle ? (languageManager.rtl ? mdiArrowLeft : mdiArrowRight) : mdiCheck}
        onclick={() => {
          onLeave?.();
          onNext?.();
        }}
      >
        <span class="flex place-content-center place-items-center gap-2">
          {nextTitle ?? $t('done')}
        </span>
      </Button>
    </div>
  </div>
</div>

<style>
  .fl-onboarding-card {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-dialog);
    box-shadow: var(--fl-shadow-2);
  }
</style>
