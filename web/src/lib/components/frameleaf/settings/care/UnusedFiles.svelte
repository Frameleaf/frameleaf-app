<script lang="ts">
  /**
   * Library care › Unused files (FL-416, after the approved prototype `settings-v2/care/unused-files.jsx`;
   * "File trash" until FL-415). Frameleaf keeps one file per content for the whole server, so a file lands
   * here once no photo uses it any more: the extra copy an identical-files merge left, a file found in the
   * Immich folders whose content is already in the library, or an original whose last photo left the
   * Trash. Nothing here is deleted by itself.
   *
   * The server owner's alone (owner, 2026-10-23): this page is only offered to the first administrator
   * (`unusedFilesAccess`), and the server refuses its API to everyone else.
   *
   * The API does not say why each file is here, so the prototype's three "why" totals are left out; each
   * row says whose library the file was last in instead.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    emptyFileTrash,
    getFileTrash,
    restoreFileTrashItem,
    type FileTrashItemResponseDto,
    type FileTrashResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiChevronLeft,
    mdiChevronRight,
    mdiFileImageOutline,
    mdiTrashCanOutline,
    mdiVideoOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  /** Files per page. */
  const PER_PAGE = 20;
  const VIDEO = /\.(mov|mp4|m4v|avi|mkv|webm|mts|m2ts|3gp|wmv|mpg|mpeg)$/i;

  let pageIndex = $state(0);
  let list = $state<FileTrashResponseDto>();
  let failed = $state(false);
  let busy = $state<string | null>(null);
  let emptying = $state(false);
  /** Files restored from this page, shown as restored until the page is read again. */
  let restored = $state<string[]>([]);
  let said = $state('');

  const load = async (index: number) => {
    try {
      list = await getFileTrash({ page: index + 1, size: PER_PAGE });
      failed = false;
    } catch {
      failed = true;
    }
  };

  $effect(() => {
    void load(pageIndex);
  });

  const total = $derived(list?.total ?? 0);
  const waiting = $derived(Math.max(0, total - restored.length));
  const pages = $derived(Math.max(1, Math.ceil(total / PER_PAGE)));
  const first = $derived(total === 0 ? 0 : pageIndex * PER_PAGE + 1);
  const last = $derived(Math.min(total, (pageIndex + 1) * PER_PAGE));
  const empty = $derived(!!list && total === 0);
  /** What the files restored from this page took, so the totals say what is still waiting. */
  const restoredBytes = $derived(
    (list?.items ?? []).filter((item) => restored.includes(item.id)).reduce((sum, item) => sum + item.sizeInBytes, 0),
  );
  const size = $derived(formatBytes(Math.max(0, (list?.totalBytes ?? 0) - restoredBytes), $locale));
  const since = (value: string) => {
    const when = DateTime.fromISO(value).setLocale($locale ?? 'en');
    return when.hasSame(DateTime.now(), 'day')
      ? $t('frameleaf_unused_today')
      : when.toLocaleString({ day: 'numeric', month: 'short' });
  };

  const restore = async (item: FileTrashItemResponseDto) => {
    busy = item.id;
    try {
      await restoreFileTrashItem({ id: item.id });
      restored = [...restored, item.id];
      said = $t('frameleaf_unused_restored', { values: { name: item.originalFileName, owner: item.lastOwnerName } });
      void unusedFilesAccess.refresh();
    } catch (error) {
      handleError(error, $t('frameleaf_unused_error'));
    } finally {
      busy = null;
    }
  };

  const emptyAll = async () => {
    if (!list) {
      return;
    }
    const count = waiting;
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_unused_empty_title', { values: { size } }),
      prompt: $t('frameleaf_unused_empty_prompt', { values: { count, size } }),
      confirmText: $t('frameleaf_unused_empty_confirm', { values: { size } }),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    emptying = true;
    try {
      const result = await emptyFileTrash();
      said =
        result.kept > 0
          ? $t('frameleaf_unused_emptied_kept', {
              values: { count: result.files, size: formatBytes(result.bytes, $locale), kept: result.kept },
            })
          : $t('frameleaf_unused_emptied', {
              values: { count: result.files, size: formatBytes(result.bytes, $locale) },
            });
      restored = [];
      pageIndex = 0;
      await load(0);
      void unusedFilesAccess.refresh();
    } catch (error) {
      handleError(error, $t('frameleaf_unused_error'));
    } finally {
      emptying = false;
    }
  };

  const go = (index: number) => {
    restored = [];
    pageIndex = index;
  };
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  <Hero
    tone={!list ? 'quiet' : empty ? 'good' : 'quiet'}
    icon={empty ? mdiCheckCircleOutline : mdiTrashCanOutline}
    title={failed
      ? $t('frameleaf_unused_unread')
      : !list
        ? $t('frameleaf_unused_loading')
        : empty
          ? $t('frameleaf_unused_hero_empty')
          : $t('frameleaf_unused_hero', { values: { count: waiting, size } })}
    body={!list ? undefined : empty ? $t('frameleaf_unused_hero_empty_body') : $t('frameleaf_unused_hero_body')}
    label={$t('frameleaf_unused_status')}
  >
    {#snippet actions()}
      {#if list && !empty}
        <Button variant="primary" disabled={emptying || busy !== null} onclick={emptyAll}>
          <Icon icon={mdiTrashCanOutline} size="1em" aria-hidden />
          {$t('frameleaf_unused_empty')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  {#if list && !empty}
    <Section title={$t('frameleaf_unused_waiting_title')} description={$t('frameleaf_unused_waiting_description')}>
      <ItemList>
        {#each list.items as item (item.id)}
          {@const back = restored.includes(item.id)}
          <Item
            icon={VIDEO.test(item.originalFileName) ? mdiVideoOutline : mdiFileImageOutline}
            quiet
            off={back}
            name={item.originalFileName}
            detail={item.lastOwnerName
              ? $t('frameleaf_unused_last_in', { values: { owner: item.lastOwnerName } })
              : $t('frameleaf_unused_removed_account')}
            tone={back ? 'good' : 'off'}
            status={back
              ? $t('frameleaf_unused_restored_status')
              : $t('frameleaf_unused_since', { values: { when: since(item.trashedAt) } })}
          >
            {#snippet measure()}
              <strong class="size">{formatBytes(item.sizeInBytes, $locale)}</strong>
            {/snippet}
            {#snippet action()}
              <Button
                disabled={back || !item.lastOwnerName || busy !== null || emptying}
                label={$t('frameleaf_unused_restore_named', { values: { name: item.originalFileName } })}
                onclick={() => restore(item)}
              >
                {$t('frameleaf_unused_restore')}
              </Button>
            {/snippet}
          </Item>
        {/each}
      </ItemList>
      <nav class="pager" aria-label={$t('frameleaf_unused_pages')}>
        <span>{$t('frameleaf_unused_range', { values: { first, last, total } })}</span>
        <Button label={$t('frameleaf_unused_previous')} disabled={pageIndex === 0} onclick={() => go(pageIndex - 1)}>
          <Icon icon={mdiChevronLeft} size="18" aria-hidden />
        </Button>
        <span>{$t('frameleaf_unused_page', { values: { page: pageIndex + 1, pages } })}</span>
        <Button label={$t('frameleaf_unused_next')} disabled={pageIndex >= pages - 1} onclick={() => go(pageIndex + 1)}>
          <Icon icon={mdiChevronRight} size="18" aria-hidden />
        </Button>
      </nav>
    </Section>
  {/if}
</KitPage>

<style>
  .size {
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  /* settings-v2/care.css .care-pager */
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4) 0 var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pager > span:first-child {
    margin-inline-end: auto;
  }
</style>
