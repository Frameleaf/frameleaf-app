<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetAllMetadata, type AssetAllMetadataResponseDto, type AssetResponseDto } from '@frameleaf/sdk';
  import { Button, LoadingSpinner } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';

  let { asset }: { asset: AssetResponseDto } = $props();
  let open = $state(false);
  let filter = $state('');
  let pageSize = $state(100);
  let result = $state<AssetAllMetadataResponseDto>();
  let error = $state(false);
  let copyStatus = $state<'copied' | 'failed'>();
  let request = 0;

  const filtered = $derived.by(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return (result?.groups ?? [])
      .map(({ name, tags }) => ({
        name,
        tags:
          needle && !name.toLocaleLowerCase().includes(needle)
            ? tags.filter(({ key, value }) => `${key} ${value}`.toLocaleLowerCase().includes(needle))
            : tags,
      }))
      .filter(({ tags }) => tags.length);
  });

  const displayed = $derived.by(() => {
    let left = pageSize;
    return filtered.flatMap(({ name, tags }) => {
      if (left <= 0) {
        return [];
      }
      const shown = tags.slice(0, left);
      left -= shown.length;
      return [{ name, tags: shown }];
    });
  });
  const matchCount = $derived(filtered.reduce((count, group) => count + group.tags.length, 0));

  const load = async () => {
    const current = ++request;
    open = true;
    error = false;
    copyStatus = undefined;
    result = undefined;
    filter = '';
    pageSize = 100;
    try {
      const response = await getAssetAllMetadata({ id: asset.id, ...authManager.params });
      if (current === request) {
        result = response;
      }
    } catch {
      if (current === request) {
        error = true;
      }
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        filtered
          .map(({ name, tags }) => [name, ...tags.map(({ key, value }) => `${key}: ${value}`)].join('\n'))
          .join('\n\n'),
      );
      copyStatus = 'copied';
    } catch {
      copyStatus = 'failed';
    }
  };

  const searchHref = (key: string, value: string) => {
    if (authManager.isSharedLink || !value || value.length > 500) {
      return;
    }
    const tag = key.split(':').at(-1);
    if (tag === 'Model') {
      return Route.search({ filter: { model: { eq: value } } });
    }
    if (tag === 'LensModel') {
      return Route.search({ filter: { lensModel: { eq: value } } });
    }
    if (tag && ['Keywords', 'Subject', 'HierarchicalSubject'].includes(tag)) {
      const ids = (asset.tags ?? []).filter((tag) => tag.name === value || tag.value === value).map((tag) => tag.id);
      if (ids.length) return Route.search({ tagIds: ids });
    }
  };
</script>

<Button variant="ghost" onclick={load}>{$t('frameleaf_all_metadata')}</Button>

<Dialog bind:open title={$t('frameleaf_all_metadata')} closeLabel={$t('close')} size="medium">
  {#if error}
    <p role="alert">{$t('frameleaf_all_metadata_error')}</p>
  {:else if !result}
    <LoadingSpinner />
  {:else}
    <label class="filter">
      <span>{$t('search')}</span>
      <input type="search" bind:value={filter} oninput={() => (pageSize = 100)} data-initial-focus />
    </label>
    {#if result.truncated}
      <p role="status">{$t('frameleaf_all_metadata_truncated')}</p>
    {/if}
    {#if matchCount === 0}
      <p>{$t('no_results')}</p>
    {/if}
    {#each displayed as group (group.name)}
      <section>
        <h3>{group.name}</h3>
        <dl>
          {#each group.tags as { key, value } (key)}
            {@const href = searchHref(key, value)}
            <dt>{key}</dt>
            <dd>
              {#if href}<a {href}>{value}</a>{:else}{value}{/if}
            </dd>
          {/each}
        </dl>
      </section>
    {/each}
    {#if matchCount > pageSize}
      <Button variant="ghost" onclick={() => (pageSize += 100)}>{$t('frameleaf_all_metadata_more')}</Button>
    {/if}
  {/if}
  {#snippet actions()}
    {#if result}
      {#if copyStatus}
        <span role="status"
          >{$t(copyStatus === 'copied' ? 'copied_to_clipboard' : 'errors.unable_to_copy_to_clipboard')}</span
        >
      {/if}
      <Button variant="outline" disabled={!matchCount} onclick={copy}>{$t('copy_to_clipboard')}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .filter {
    display: grid;
    gap: 0.5rem;
  }
  input {
    padding: 0.65rem 0.8rem;
    border: 1px solid var(--fl-line);
    border-radius: 0.6rem;
  }
  section {
    padding-block: 1rem;
  }
  h3 {
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: 0.5rem 1rem;
  }
  dt,
  dd {
    overflow-wrap: anywhere;
  }
  a {
    text-decoration: underline;
  }
</style>
