<script lang="ts">
  /**
   * Remove an external library in two stages (FL-78), the design template's `remove-library`
   * action in `design/frameleaf/template/src/AccountsLibraries.jsx`.
   *
   * Stage one asks the server what the removal takes with it — indexed items, albums and shared
   * links that lose items, detected faces, whether a scan is running — and hands back a token bound
   * to the library as it is. Stage two sends the typed name with that token. If the library
   * changed in between (a scan imported more, the folders changed), the server refuses and this
   * dialog reviews again rather than confirming consequences nobody saw. Source files are never
   * part of the removal.
   *
   * The confirmation is the shared typed one (design review finding 74): the library's name, then
   * the danger button. The separate "I understand" tick is gone; the number of items it named is
   * the first consequence in the list, and a new review asks for the name again.
   */
  import '$lib/frameleaf/libraries.css';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TypedConfirmation from '$lib/components/frameleaf/settings/TypedConfirmation.svelte';
  import { matchesTyped } from '$lib/components/frameleaf/settings/typed-confirmation';
  import { serverStatus } from '$lib/frameleaf/libraries';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getLibraryRemovalReview, removeLibrary, type LibraryRemovalReviewDto } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    libraryId: string;
    onRemoved: () => void;
    onClose: () => void;
  };

  let { libraryId, onRemoved, onClose }: Props = $props();

  let open = $state(true);
  let review = $state<LibraryRemovalReviewDto | null>(null);
  let confirmation = $state('');
  let error = $state('');
  let loading = $state(false);
  let removing = $state(false);

  const matched = $derived(!!review && matchesTyped(review.name, confirmation));

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const load = async () => {
    loading = true;
    // What was typed confirmed the review it was typed under, not the next one.
    confirmation = '';
    try {
      review = await getLibraryRemovalReview({ id: libraryId });
    } catch (error_) {
      review = null;
      error = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_remove_review_error');
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    void load();
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!review) {
      return;
    }
    if (!matched) {
      error = $t('frameleaf_libraries_remove_name_mismatch');
      return;
    }

    error = '';
    removing = true;
    try {
      await removeLibrary({
        id: libraryId,
        libraryRemovalDto: { reviewToken: review.reviewToken, confirmName: review.name },
      });
      onRemoved();
      open = false;
    } catch (error_) {
      if (serverStatus(error_) === 409) {
        error = $t('frameleaf_libraries_remove_stale');
        await load();
      } else {
        error = getServerErrorMessage(error_) ?? $t('frameleaf_libraries_remove_error');
      }
    } finally {
      removing = false;
    }
  };
</script>

<div class="fl-libraries">
  <Dialog bind:open title={$t('frameleaf_libraries_remove_title')} closeLabel={$t('frameleaf_libraries_close_dialog')}>
    {#if error}
      <p class="resource-error" role="alert">{error}</p>
    {/if}
    {#if loading && !review}
      <p role="status">{$t('frameleaf_libraries_remove_loading')}</p>
    {:else if review}
      <form onsubmit={submit}>
        <p>{$t('frameleaf_libraries_remove_intro', { values: { name: review.name } })}</p>
        <ul class="resource-consequences" aria-label={$t('frameleaf_libraries_remove_title')}>
          <li>{$t('frameleaf_libraries_remove_items', { values: { count: review.total } })}</li>
          {#if review.albums > 0}
            <li>{$t('frameleaf_libraries_remove_albums', { values: { count: review.albums } })}</li>
          {/if}
          {#if review.sharedLinks > 0}
            <li>{$t('frameleaf_libraries_remove_links', { values: { count: review.sharedLinks } })}</li>
          {/if}
          {#if review.faces > 0}
            <li>{$t('frameleaf_libraries_remove_faces', { values: { count: review.faces } })}</li>
          {/if}
          {#if review.offline > 0}
            <li>{$t('frameleaf_libraries_remove_offline', { values: { count: review.offline } })}</li>
          {/if}
          {#if review.scanActive}
            <li>{$t('frameleaf_libraries_remove_scan')}</li>
          {/if}
          <li>{$t('frameleaf_libraries_remove_locked')}</li>
        </ul>
        <TypedConfirmation
          label={$t('frameleaf_libraries_remove_confirm_name')}
          placeholder={review.name}
          initialFocus
          disabled={removing}
          bind:value={confirmation}
        />
        <footer>
          <button type="button" class="resource-button" onclick={() => (open = false)}>
            {$t('frameleaf_libraries_cancel')}
          </button>
          <button type="submit" class="resource-button danger" disabled={removing || loading || !matched}>
            {$t('frameleaf_libraries_remove')}
          </button>
        </footer>
      </form>
    {/if}
  </Dialog>
</div>
