<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { forgetDevelopStyle, getDevelopStyle, learnDevelopStyle, type DevelopStyleDto } from '@frameleaf/sdk';

  let { onChanged }: { onChanged: (learned: boolean) => void } = $props();
  let style = $state<DevelopStyleDto>();
  let working = $state(true);
  let failed = $state(false);

  const run = async (action: () => Promise<DevelopStyleDto>) => {
    working = true;
    failed = false;
    try {
      style = await action();
      onChanged(style.learnedEdits !== null);
    } catch {
      failed = true;
    } finally {
      working = false;
    }
  };
  onMount(() => void run(getDevelopStyle));
</script>

<section class="phw-brand-main my-style" aria-busy={working}>
  <h2>{$t('frameleaf_photography_style_learn')}</h2>
  <p>{$t('frameleaf_photography_style_lead')}</p>
  {#if style?.learnedEdits != null}
    <p>{$t('frameleaf_photography_style_learned', { values: { count: style.learnedEdits } })}</p>
    <button
      type="button"
      class="phw-button"
      disabled={working}
      onclick={() =>
        run(async () => {
          await forgetDevelopStyle();
          return getDevelopStyle();
        })}>{$t('frameleaf_photography_style_forget')}</button
    >
  {:else if style}
    {#if style.availableEdits < 50}
      <p>{$t('frameleaf_photography_style_needed', { values: { count: 50 - style.availableEdits } })}</p>
    {/if}
    <button
      type="button"
      class="phw-primary"
      disabled={working || style.availableEdits < 50}
      onclick={() => run(learnDevelopStyle)}
    >
      {$t('frameleaf_photography_style_learn')}
    </button>
  {/if}
  {#if failed}<p role="alert">{$t('frameleaf_photography_style_failed')}</p>{/if}
</section>

<style>
  .my-style {
    display: grid;
    justify-items: start;
    gap: 0.75rem;
    max-width: 42rem;
    padding: 1.25rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.75rem;
  }
</style>
