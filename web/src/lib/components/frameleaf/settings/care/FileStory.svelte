<script lang="ts">
  /**
   * What happened (FL-1338, the prototype's `Story` sheet in `settings-v2/care/files.jsx`): one damaged
   * or missing file, its picture, the facts, every step Frameleaf took in plain words (`file-steps.ts`)
   * and what the person can do, by how the fixes left it (design §7).
   *
   * Only the photo's owner acts on it (`canAct`). Another account's file, which an administrator sees in
   * the household's list, shows no picture at all and offers only Try again. The server's refusals
   * (an Undo after the photo changed, a folder it can't search) are written for people and shown as
   * they are. Look in a folder lists only folders the server can already see; any other drive is added
   * in Frameleaf Manager first, which an administrator is linked to and a member is told about.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import LibraryCareRepairDialog from '$lib/components/frameleaf/LibraryCareRepairDialog.svelte';
  import Choice from '$lib/components/frameleaf/settings/kit/Choice.svelte';
  import Facts, { type Fact } from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import {
    damagedFileName,
    dispositionFileName,
    offersLookIn,
    offersRepair,
    problemKind,
    storyWords,
  } from '$lib/frameleaf/file-steps';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob, getAssetMediaUrl } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetVisibility,
    deleteAssets,
    downloadFileProblemKeptFile,
    getAssetInfo,
    getFileProblem,
    getFileProblemFolders,
    getManagerAccess,
    isHttpError,
    keepFileProblem,
    lookInFolderForFileProblem,
    MediaHealthCategory,
    tryFileProblemAgain,
    undoFileProblemFix,
    type FileProblemDto,
    type FileProblemFolderDto,
    type FileProblemRowDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiFileAlertOutline, mdiImageOffOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    id,
    row,
    onDone,
    onClose,
  }: {
    /** The problem (its finding). */
    id: string;
    /** Its row, when the sheet was opened from the list: names the sheet before the history arrives. */
    row?: FileProblemRowDto;
    /** An action finished: what to say on the page. The sheet closes itself. */
    onDone: (message: string) => void;
    /** The sheet has closed. */
    onClose: () => void;
  } = $props();

  const isAdmin = $derived(authManager.user.isAdmin);

  let open = $state(true);
  let problem = $state<FileProblemDto>();
  let loadFailed = $state<string>();
  let failure = $state<string>();
  let working = $state(false);
  let taken = $state<string>();
  /** The photo is Locked now: the server won't hand over the kept file, so the button isn't offered. */
  let locked = $state(false);
  let repairing = $state(false);

  let looking = $state(false);
  /** Undefined until they are read; a failed read leaves them so, and the next open reads them again. */
  let folders = $state<FileProblemFolderDto[]>();
  let foldersFailed = $state(false);
  let folderId = $state('');
  let lookFailure = $state<string>();
  let managerUrl = $state<string | null>(null);

  /** The server's own words for a refusal it wrote for people; anything else is said plainly. */
  const failureOf = (error: unknown, statuses = [400, 403, 409]) =>
    (isHttpError(error) && statuses.includes(error.status) ? getServerErrorMessage(error) : undefined) ??
    $t('frameleaf_files_action_failed');

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await getFileProblem({ id });
        if (!active) {
          return;
        }
        problem = loaded;
        // when it was taken is the photo's own detail: only for the account that may see it
        if (loaded.pictureAllowed) {
          const info = await getAssetInfo({ id: loaded.assetId }).catch(() => undefined);
          if (active && info?.visibility === AssetVisibility.Locked) {
            locked = true;
          }
          if (active && info?.localDateTime) {
            taken = new Intl.DateTimeFormat($locale, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(info.localDateTime));
          }
        }
      } catch (error) {
        if (active) {
          loadFailed = failureOf(error);
        }
      }
    })();
    return () => {
      active = false;
    };
  });

  const shown = $derived(problem ?? row);
  const kind = $derived(shown ? problemKind(shown) : undefined);
  const name = $derived(shown?.originalFileName ?? '');
  const own = $derived(!!shown?.canAct);

  const told = $derived(problem ? storyWords(problem, $t, { locale: $locale }) : []);
  const when = (value: string) => {
    const words = backupWhen(new Date(value), { locale: $locale });
    return $t(words.key, { values: words.values });
  };

  /** How much of the picture a part-saved repair lost, for the notice: the rest is grey. */
  const lostPercent = $derived.by(() => {
    if (kind !== 'repaired' || !problem?.partSaved) {
      return;
    }
    const saved = problem.steps.findLast(({ step }) => step === 'repaired')?.facts.percentSaved;
    return typeof saved === 'number' && saved < 100 ? 100 - saved : undefined;
  });

  const now = $derived.by(() => {
    switch (kind) {
      case 'repaired': {
        return problem?.partSaved ? $t('frameleaf_files_state_part_saved_now') : $t('frameleaf_files_state_repaired');
      }
      case 'found': {
        return $t('frameleaf_files_state_found');
      }
      case 'missing': {
        return shown?.fixState === 'waiting-phone'
          ? $t('frameleaf_files_state_waiting_phone')
          : $t('frameleaf_files_state_missing');
      }
      case 'unrepairable': {
        return $t('frameleaf_files_state_cant_repair');
      }
      case 'unchecked': {
        return $t('frameleaf_files_state_unchecked');
      }
      default: {
        return $t('frameleaf_files_state_kept');
      }
    }
  });

  const facts = $derived<Fact[]>(
    shown
      ? [
          { label: $t('frameleaf_files_fact_now'), value: now },
          ...(taken ? [{ label: $t('frameleaf_files_fact_taken'), value: taken }] : []),
          {
            label: $t('frameleaf_files_fact_library'),
            value: $t('frameleaf_files_fact_library_value', { values: { owner: shown.ownerName } }),
          },
        ]
      : [],
  );

  const caption = $derived(
    kind === 'missing'
      ? $t('frameleaf_files_story_preview_left')
      : kind === 'unrepairable' || kind === 'unchecked'
        ? $t('frameleaf_files_story_preview_before')
        : undefined,
  );

  const hideBroken = (event: Event) => {
    (event.currentTarget as HTMLImageElement).hidden = true;
  };

  const finish = (message: string) => {
    onDone(message);
    open = false;
  };
  const act = async (call: () => Promise<unknown>, message: () => string) => {
    working = true;
    failure = undefined;
    try {
      await call();
      finish(message());
    } catch (error) {
      failure = failureOf(error);
    } finally {
      working = false;
    }
  };

  const undo = () =>
    act(
      () => undoFileProblemFix({ id }),
      () =>
        kind === 'repaired'
          ? $t('frameleaf_files_undone_repair', { values: { name } })
          : shown?.category === MediaHealthCategory.Missing
            ? $t('frameleaf_files_undone_found', { values: { name } })
            : $t('frameleaf_files_undone_changed', { values: { name } }),
    );
  const keep = () =>
    act(
      () => keepFileProblem({ id }),
      () => $t('frameleaf_files_kept', { values: { name } }),
    );
  const tryAgain = () =>
    act(
      () => tryFileProblemAgain({ id }),
      () => $t('frameleaf_files_trying', { values: { name } }),
    );
  /** The damaged file a repair kept, saved under the name the server gives it (its `Content-Disposition`). */
  const downloadDamaged = async () => {
    working = true;
    failure = undefined;
    try {
      let disposition: string | null = null;
      const blob = await downloadFileProblemKeptFile(
        { id },
        {
          fetch: async (...args) => {
            const response = await fetch(...args);
            disposition = response.headers.get('content-disposition');
            return response;
          },
        },
      );
      downloadBlob(blob, dispositionFileName(disposition) ?? damagedFileName(name));
    } catch (error) {
      failure = failureOf(error, [400, 403, 404, 409]);
    } finally {
      working = false;
    }
  };
  /** Remove goes through the Trash as usual (design §7), after asking. */
  const remove = async () => {
    const assetId = shown?.assetId;
    if (!assetId) {
      return;
    }
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_files_remove_title', { values: { name } }),
      prompt: kind === 'missing' ? $t('frameleaf_files_remove_prompt_missing') : $t('frameleaf_files_remove_prompt'),
      confirmText: $t('frameleaf_files_remove_confirm'),
    });
    if (confirmed) {
      await act(
        () => deleteAssets({ assetBulkDeleteDto: { ids: [assetId] } }),
        () => $t('frameleaf_files_removed', { values: { name } }),
      );
    }
  };

  const openLook = async () => {
    folderId = '';
    lookFailure = undefined;
    looking = true;
    if (isAdmin && managerUrl === null) {
      void getManagerAccess()
        .then((value) => (managerUrl = value.url))
        .catch(() => {});
    }
    if (!folders) {
      foldersFailed = false;
      try {
        folders = await getFileProblemFolders();
      } catch {
        foldersFailed = true;
      }
    }
  };
  const lookIn = async () => {
    const folder = folders?.find((candidate) => candidate.id === folderId);
    if (!folder) {
      return;
    }
    working = true;
    lookFailure = undefined;
    try {
      await lookInFolderForFileProblem({ id, fileProblemLookInDto: { folderId: folder.id } });
      looking = false;
      finish($t('frameleaf_files_looking', { values: { folder: folder.name } }));
    } catch (error) {
      lookFailure = failureOf(error);
    } finally {
      working = false;
    }
  };

  type Action = { id: string; label: string; primary?: boolean; run: () => unknown };
  const closeSheet = () => (open = false);
  /** The sheet's buttons by how the fixes left the file, left to right, the primary one last (design §7). */
  const buttons = $derived.by((): Action[] => {
    const done: Action = { id: 'done', label: $t('done'), primary: true, run: closeSheet };
    if (!problem) {
      return [done];
    }
    if (!own) {
      // another account's file: an administrator may only ask Frameleaf to try again
      return isAdmin ? [{ id: 'again', label: $t('frameleaf_files_try_again'), run: tryAgain }, done] : [done];
    }
    const removeAction: Action = { id: 'remove', label: $t('frameleaf_files_remove'), run: remove };
    const keepAction: Action = { id: 'keep', label: $t('frameleaf_files_keep'), run: keep };
    const lookAction: Action = { id: 'look', label: $t('frameleaf_files_look'), primary: true, run: openLook };
    switch (kind) {
      case 'repaired': {
        return [
          { id: 'undo', label: $t('frameleaf_files_undo_repair'), run: undo },
          ...(locked
            ? []
            : [{ id: 'download-damaged', label: $t('frameleaf_files_download_damaged'), run: downloadDamaged }]),
          { id: 'keep-repaired', label: $t('frameleaf_files_keep_repaired'), primary: true, run: closeSheet },
        ];
      }
      case 'found': {
        return [{ id: 'undo', label: $t('frameleaf_files_undo'), run: undo }, done];
      }
      case 'missing': {
        return [removeAction, lookAction];
      }
      case 'unrepairable': {
        // Repair… is FL-1273's reviewed repair, for damage automatic repair was off for or that was undone
        if (offersRepair(problem)) {
          return [
            removeAction,
            keepAction,
            { id: 'repair', label: $t('frameleaf_files_repair'), primary: true, run: () => (repairing = true) },
          ];
        }
        // a copy is worth looking for only when the file changed after Frameleaf stored it: one that arrived
        // damaged has the same damage in every exact copy, and the server refuses to look
        return offersLookIn(problem)
          ? [removeAction, keepAction, lookAction]
          : [removeAction, { ...keepAction, primary: true }];
      }
      case 'unchecked': {
        // it couldn't be read after three tries: the person may ask for another
        return [
          removeAction,
          keepAction,
          { id: 'again', label: $t('frameleaf_files_try_again'), primary: true, run: tryAgain },
        ];
      }
      default: {
        return [done];
      }
    }
  });
</script>

<Dialog
  title={shown?.originalFileName ?? $t('frameleaf_files_story_heading')}
  closeLabel={$t('close')}
  bind:open
  size="wide"
  onClosed={onClose}
>
  <div class="story">
    {#if loadFailed}
      <Notice tone="warn">{loadFailed}</Notice>
    {:else if !problem}
      <p class="loading">{$t('frameleaf_files_story_loading')}</p>
    {:else}
      {#if failure}
        <Notice tone="warn">{failure}</Notice>
      {/if}
      {#if !problem.pictureAllowed}
        <!-- Library care never shows one account another's pictures: no picture and no request for one. -->
        <Notice title={$t('frameleaf_files_story_private_title', { values: { owner: problem.ownerName } })}>
          {$t('frameleaf_files_story_private_body', { values: { owner: problem.ownerName } })}
        </Notice>
      {:else if kind === 'repaired'}
        <div class="compare">
          <figure>
            <span class="picture is-damaged">
              <Icon icon={mdiFileAlertOutline} size="32" aria-hidden />
              <span>{$t('frameleaf_files_story_wont_open')}</span>
            </span>
            <figcaption>{$t('frameleaf_files_story_damaged_kept')}</figcaption>
          </figure>
          <figure>
            <span class="picture">
              <img
                src={getAssetMediaUrl({
                  id: problem.assetId,
                  size: AssetMediaSize.Preview,
                  cacheKey: problem.updatedAt,
                })}
                alt=""
                onerror={hideBroken}
              />
            </span>
            <figcaption>{$t('frameleaf_files_story_repaired_photo')}</figcaption>
          </figure>
        </div>
      {:else}
        <figure class="single">
          <span
            class="picture"
            class:is-missing={kind === 'missing'}
            class:is-faded={kind === 'unrepairable' || kind === 'unchecked'}
          >
            <img
              src={getAssetMediaUrl({ id: problem.assetId, size: AssetMediaSize.Preview, cacheKey: problem.updatedAt })}
              alt=""
              onerror={hideBroken}
            />
            {#if kind === 'missing'}<span class="badge"><Icon icon={mdiImageOffOutline} size="16" aria-hidden /></span
              >{/if}
          </span>
          {#if caption}<figcaption>{caption}</figcaption>{/if}
        </figure>
      {/if}
      <Facts rows={facts} />
      {#if lostPercent !== undefined}
        <Notice tone="warn" title={$t('frameleaf_files_part_title')}>
          {$t('frameleaf_files_part_body', { values: { percent: lostPercent } })}
        </Notice>
      {/if}
      <h3>{$t('frameleaf_files_story_heading')}</h3>
      <HistoryList>
        {#each told as { step, words }, index (index)}
          <HistoryRow when={when(step.at)} datetime={step.at} what={words.what} detail={words.detail}>
            {#if words.result}<Pill tone={words.result.tone}>{words.result.text}</Pill>{/if}
          </HistoryRow>
        {/each}
      </HistoryList>
    {/if}
  </div>
  {#snippet actions()}
    {#each buttons as action (action.id)}
      <Button variant={action.primary ? 'primary' : 'default'} disabled={working} onclick={() => void action.run()}>
        {action.label}
      </Button>
    {/each}
  {/snippet}
</Dialog>

{#if looking}
  <Dialog title={$t('frameleaf_files_look_title')} closeLabel={$t('close')} bind:open={looking}>
    <div class="look">
      <p>{$t('frameleaf_files_look_intro')}</p>
      {#if lookFailure}
        <Notice tone="warn">{lookFailure}</Notice>
      {/if}
      {#if folders && folders.length > 0}
        <Choice
          label={$t('frameleaf_files_look_folders')}
          value={folderId}
          options={folders.map((folder) => ({ value: folder.id, label: folder.name }))}
          onChange={(value) => (folderId = value)}
        />
      {:else if folders}
        <p class="quiet">{$t('frameleaf_files_look_none')}</p>
      {:else if foldersFailed}
        <Notice tone="warn">{$t('frameleaf_files_look_failed')}</Notice>
      {/if}
      <!-- Only folders the server can already see; another drive is added in Frameleaf Manager first. -->
      {#if isAdmin}
        <div class="other">
          <p class="quiet">{$t('frameleaf_files_look_other_admin')}</p>
          {#if managerUrl}
            <a class="fl-control button" href={`${managerUrl}/#services`} target="_blank" rel="noopener noreferrer"
              >{$t('frameleaf_move_open_manager')}</a
            >
          {/if}
        </div>
      {:else}
        <p class="quiet">{$t('frameleaf_files_look_other_member')}</p>
      {/if}
    </div>
    {#snippet actions()}
      <Button onclick={() => (looking = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={working || !folderId} onclick={() => void lookIn()}>
        {$t('frameleaf_files_look_start')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

{#if repairing && problem}
  <LibraryCareRepairDialog
    bind:open={repairing}
    findingId={problem.id}
    assetId={problem.assetId}
    name={problem.originalFileName}
    onRepaired={() => finish($t('library_care_repair_done', { values: { name } }))}
  />
{/if}

<style>
  /* care.css `.care-story`: the sheet's pieces 16px apart. */
  .story {
    display: grid;
    gap: var(--fl-space-4);
  }
  .story > :global(.kit-facts) {
    padding-bottom: 0;
  }
  .loading,
  .quiet {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .compare {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--fl-space-4);
  }
  figure {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
  }
  figcaption {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .picture {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    max-height: 220px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .single .picture {
    max-width: 320px;
  }
  .picture img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .picture.is-missing img {
    filter: grayscale(1);
    opacity: 0.55;
  }
  .picture.is-faded img {
    filter: grayscale(1);
    opacity: 0.4;
  }
  /* The damaged file of a repair: it won't open, which is why it was repaired. */
  .picture.is-damaged {
    place-content: center;
    justify-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .badge {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: grid;
    place-items: center;
    padding: 3px;
    color: var(--fl-warning);
    background: var(--fl-panel);
    border-radius: 50%;
  }
  /* care.css `.care-story-heading`: one step of the sheet's rhythm above the history. */
  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .look {
    display: grid;
    gap: var(--fl-space-3);
  }
  .look > p:first-child {
    margin: 0;
  }
  .other {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-3);
  }
  @media (max-width: 640px) {
    .compare {
      grid-template-columns: 1fr;
    }
  }
</style>
