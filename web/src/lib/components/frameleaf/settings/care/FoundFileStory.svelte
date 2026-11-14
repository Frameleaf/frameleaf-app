<script lang="ts">
  /**
   * One found file's story (FL-1533, the prototype's `Story` in `care/found-files.jsx`): its picture,
   * where it was found, every step Frameleaf took with it, and Undo. A file put back under a missing
   * photo can be undone, an added photo can be taken out of the library, and a spare copy can be
   * deleted after the server has checked the photo it copies. A file that was left alone after an Undo
   * can be sorted again (FL-1579). Another account's file shows no picture and offers nothing but Done.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { foundFileUrl, foundPicture, sortedAgainWords } from '$lib/components/frameleaf/settings/care/found-files';
  import Facts, { type Fact } from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    AssetMediaSize,
    deleteSpareFoundFiles,
    FoundFileOutcome,
    FoundFileReason,
    getFoundFile,
    sortFoundFileAgain,
    undoFoundFile,
    type FoundFileDetailResponseDto,
    type FoundFileStepDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiFileOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let {
    id,
    users,
    onDone,
    onClose,
  }: {
    id: string;
    users: { id: string; name: string }[];
    /**
     * Something was changed: the list is out of date, and this is what to say. `left` is the file an
     * Undo left alone, which the page offers to sort again.
     */
    onDone: (message: string, left?: { id: string; name: string }) => void;
    onClose: () => void;
  } = $props();

  let open = $state(true);
  let file = $state<FoundFileDetailResponseDto>();
  let loadFailed = $state(false);
  let failure = $state('');
  let working = $state(false);
  /** Deleting a spare copy asks once more, in the sheet. */
  let confirming = $state(false);

  onMount(() => {
    getFoundFile({ id })
      .then((found) => (file = found))
      .catch(() => (loadFailed = true));
  });

  const owner = $derived(users.find((user) => user.id === file?.ownerId)?.name);
  const src = $derived(file ? foundPicture(file, AssetMediaSize.Preview) : undefined);
  const when = (value: string) => {
    const words = backupWhen(new Date(value), { locale: $locale });
    return $t(words.key, { values: words.values });
  };

  const NOW: Record<FoundFileOutcome, { tone: KitTone; label: Translations }> = {
    [FoundFileOutcome.Back]: { tone: 'good', label: 'frameleaf_found_now_back' },
    [FoundFileOutcome.Added]: { tone: 'good', label: 'frameleaf_found_now_added' },
    [FoundFileOutcome.Spare]: { tone: 'off', label: 'frameleaf_found_now_spare' },
    [FoundFileOutcome.Needs]: { tone: 'warn', label: 'frameleaf_found_now_needs' },
    [FoundFileOutcome.Left]: { tone: 'off', label: 'frameleaf_found_now_left' },
  };
  const WAITING: Record<FoundFileReason, Translations> = {
    [FoundFileReason.NoOwner]: 'frameleaf_found_step_no_owner',
    [FoundFileReason.WontOpen]: 'frameleaf_found_step_wont_open',
    [FoundFileReason.OverLimit]: 'frameleaf_found_step_over_limit',
    [FoundFileReason.Asked]: 'frameleaf_found_step_asked',
  };

  const facts = $derived.by((): Fact[] => {
    if (!file) {
      return [];
    }
    return [
      { label: $t('frameleaf_found_fact_now'), value: $t(NOW[file.outcome].label) },
      {
        label: $t('frameleaf_found_fact_library'),
        value: owner
          ? $t('frameleaf_found_fact_library_of', { values: { owner } })
          : $t('frameleaf_found_fact_library_none'),
      },
      { label: $t('frameleaf_found_fact_found_in'), value: file.path },
      ...(file.previousPath ? [{ label: $t('frameleaf_found_fact_was_at'), value: file.previousPath }] : []),
      { label: $t('frameleaf_found_fact_size'), value: getByteUnitString(file.sizeInBytes, $locale) },
    ];
  });

  /** A step in plain words; one the page does not know yet is left out rather than shown raw. */
  const STEP: Record<string, { what: Translations; detail?: Translations; tone?: KitTone; result?: Translations }> = {
    found: { what: 'frameleaf_found_step_found', detail: 'frameleaf_found_step_found_detail' },
    back: {
      what: 'frameleaf_found_step_back',
      detail: 'frameleaf_found_step_back_detail',
      tone: 'good',
      result: 'frameleaf_found_now_back',
    },
    added: {
      what: 'frameleaf_found_step_added',
      detail: 'frameleaf_found_step_added_detail',
      tone: 'good',
      result: 'frameleaf_found_now_added',
    },
    spare: {
      what: 'frameleaf_found_step_spare',
      detail: 'frameleaf_found_step_spare_detail',
      tone: 'off',
      result: 'frameleaf_found_now_spare',
    },
    'no-owner': { what: 'frameleaf_found_step_no_owner', tone: 'warn', result: 'frameleaf_found_now_needs' },
    'over-limit': { what: 'frameleaf_found_step_over_limit', tone: 'warn', result: 'frameleaf_found_now_needs' },
    'wont-open': { what: 'frameleaf_found_step_wont_open', tone: 'warn', result: 'frameleaf_found_now_needs' },
    decided: { what: 'frameleaf_found_step_decided' },
    undone: { what: 'frameleaf_found_step_undone', detail: 'frameleaf_found_step_undone_detail' },
    again: { what: 'frameleaf_found_step_again' },
  };
  const told = $derived.by(() => {
    if (!file) {
      return [];
    }
    const rows = file.steps.flatMap((step: FoundFileStepDto) => {
      const words =
        step.step === 'read'
          ? step.outcome === 'failed'
            ? { what: 'frameleaf_found_step_read_failed' as Translations, tone: 'warn' as KitTone }
            : {
                what: 'frameleaf_found_step_read' as Translations,
                detail: 'frameleaf_found_step_read_detail' as Translations,
              }
          : STEP[step.step];
      return words ? [{ step, words }] : [];
    });
    return rows;
  });
  /** A file that was held back has no step of its own for it: its reason says why it waits. */
  const waiting = $derived(
    file?.outcome === FoundFileOutcome.Needs && file.reason === FoundFileReason.Asked
      ? $t(WAITING[FoundFileReason.Asked])
      : undefined,
  );

  type Done = string | { message: string; left: { id: string; name: string } };
  const finish = (done: Done) => {
    if (typeof done === 'string') {
      onDone(done);
    } else {
      onDone(done.message, done.left);
    }
    open = false;
  };
  const run = async (action: () => Promise<Done>) => {
    working = true;
    failure = '';
    try {
      finish(await action());
    } catch {
      failure = $t('frameleaf_found_failed');
    } finally {
      working = false;
    }
  };
  const undo = () =>
    run(async () => {
      const was = file!.outcome;
      // the answer is the file that is left on the drive: the one to sort again, if asked
      const left = await undoFoundFile({ id });
      return {
        message:
          was === FoundFileOutcome.Back
            ? $t('frameleaf_found_undone_back', { values: { name: file!.fileName } })
            : $t('frameleaf_found_undone_added', { values: { name: file!.fileName } }),
        left: { id: left.id, name: left.fileName },
      };
    });
  const sortAgain = () =>
    run(async () => {
      const sorted = await sortFoundFileAgain({ id });
      return $t(sortedAgainWords(sorted.outcome), { values: { name: file!.fileName } });
    });
  const deleteCopy = () =>
    run(async () => {
      const { deleted } = await deleteSpareFoundFiles({ foundFilesDeleteSpareDto: { ids: [id] } });
      if (deleted === 0) {
        throw new Error('kept');
      }
      return $t('frameleaf_found_copy_deleted', { values: { name: file!.fileName } });
    });

  const hideBroken = (event: Event) => {
    (event.currentTarget as HTMLImageElement).hidden = true;
  };
</script>

<Dialog
  title={file?.fileName ?? $t('frameleaf_files_story_heading')}
  closeLabel={$t('close')}
  bind:open
  size="wide"
  onClosed={onClose}
>
  <div class="story">
    {#if loadFailed}
      <Notice tone="warn">{$t('frameleaf_files_load_failed')}</Notice>
    {:else if !file}
      <p class="loading">{$t('frameleaf_files_story_loading')}</p>
    {:else}
      {#if failure}
        <Notice tone="warn">{failure}</Notice>
      {/if}
      {#if !file.viewable}
        <!-- Library care never shows one account another's pictures: no picture and no request for one. -->
        <Notice
          title={owner
            ? $t('frameleaf_files_story_private_title', { values: { owner } })
            : $t('frameleaf_found_private_unnamed')}
        >
          {owner
            ? $t('frameleaf_found_story_private_body', { values: { owner } })
            : $t('frameleaf_found_story_private_body_unnamed')}
        </Notice>
      {:else}
        <figure>
          <span class="picture">
            <Icon icon={mdiFileOutline} size="32" aria-hidden />
            {#if src}<img {src} alt="" onerror={hideBroken} />{/if}
          </span>
        </figure>
      {/if}
      <Facts rows={facts} />
      {#if confirming}
        <Notice tone="warn" title={$t('frameleaf_found_copy_ask_title')}>
          {$t('frameleaf_found_copy_ask_body')}
        </Notice>
      {/if}
      <h3>{$t('frameleaf_files_story_heading')}</h3>
      <HistoryList>
        {#each told as { step, words }, index (index)}
          <HistoryRow
            when={when(step.at)}
            datetime={step.at}
            what={$t(words.what)}
            detail={'detail' in words && words.detail ? $t(words.detail) : undefined}
          >
            {#if 'result' in words && words.result}<Pill tone={words.tone ?? 'good'}>{$t(words.result)}</Pill>{/if}
          </HistoryRow>
        {/each}
        {#if waiting}
          <HistoryRow when={when(file.sortedAt)} datetime={file.sortedAt} what={waiting}>
            <Pill tone="warn">{$t('frameleaf_found_now_needs')}</Pill>
          </HistoryRow>
        {/if}
      </HistoryList>
    {/if}
  </div>
  {#snippet actions()}
    {#if file?.viewable}
      {#if file.outcome === FoundFileOutcome.Back}
        <Button disabled={working} onclick={() => void undo()}>{$t('frameleaf_found_undo')}</Button>
      {:else if file.outcome === FoundFileOutcome.Added}
        <Button disabled={working} onclick={() => void undo()}>{$t('frameleaf_found_take_out')}</Button>
      {:else if file.outcome === FoundFileOutcome.Spare}
        {#if confirming}
          <Button disabled={working} onclick={() => (confirming = false)}>{$t('cancel')}</Button>
          <Button variant="danger" disabled={working} onclick={() => void deleteCopy()}>
            {$t('frameleaf_found_copy_delete_confirm')}
          </Button>
        {:else}
          <Button variant="danger" disabled={working} onclick={() => (confirming = true)}>
            {$t('frameleaf_found_copy_delete')}
          </Button>
        {/if}
      {:else if file.outcome === FoundFileOutcome.Left}
        <Button disabled={working} onclick={() => void sortAgain()}>{$t('frameleaf_found_again')}</Button>
      {:else if file.outcome === FoundFileOutcome.Needs}
        <a class="download" href={foundFileUrl(file.id)} download={file.fileName}>{$t('frameleaf_found_download')}</a>
      {/if}
      {#if file.assetId && (file.outcome === FoundFileOutcome.Back || file.outcome === FoundFileOutcome.Added)}
        <Button disabled={working} onclick={() => void goto(Route.viewAsset({ id: file!.assetId! }))}>
          {$t('frameleaf_found_open_in_library')}
        </Button>
      {/if}
    {/if}
    {#if !confirming}
      <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .story {
    display: grid;
    gap: var(--fl-space-4);
  }
  .story > :global(.kit-facts) {
    padding-bottom: 0;
  }
  .loading {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  figure {
    margin: 0;
  }
  .picture {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    max-width: 320px;
    max-height: 220px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    color: var(--fl-muted);
    background: var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .picture img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .download {
    align-self: center;
    color: var(--fl-accent);
    font-size: var(--fl-font-callout);
  }
</style>
