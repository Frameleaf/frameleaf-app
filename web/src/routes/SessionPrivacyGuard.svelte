<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { children }: { children: Snippet } = $props();
  let status = $state<'pending' | 'ready' | 'error'>('pending');
  let guard: ReturnType<typeof watchSessionPrivacy> | undefined;
  onMount(() => {
    guard = watchSessionPrivacy(
      () => authManager.authenticated,
      (value) => (status = value),
    );
    return () => guard?.dispose();
  });
  afterNavigate(() => void guard?.refresh());
</script>

{#if status === 'ready'}
  {@render children()}
{:else}
  <div class="flex min-h-screen items-center justify-center" role="status">
    {#if status === 'error'}
      <button type="button" class="text-primary underline" onclick={() => void guard?.refresh()}>{$t('retry')}</button>
    {:else}
      {$t('loading')}
    {/if}
  </div>
{/if}
