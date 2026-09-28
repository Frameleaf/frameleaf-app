<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleUpdateAlbumInfo } from '$lib/services/album.service';
  import { AssetOrder, type AlbumResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Album, collection and shared space options (FL-53), ported from `OptionsDialog` in
   * `design/frameleaf/template/src/CollectionHeader.jsx`: display order, and whether
   * members may like and comment. Both are fields of `PATCH /albums/{id}` (`order`,
   * `isActivityEnabled`); nothing here is a local preference.
   */
  interface Props {
    album: AlbumResponseDto;
    open?: boolean;
    onUpdated: (album: AlbumResponseDto) => void;
  }

  let { album, open = $bindable(false), onUpdated }: Props = $props();

  const groupId = $props.id();

  let order = $state<AssetOrder>(album.order ?? AssetOrder.Desc);
  let activityEnabled = $state(album.isActivityEnabled);
  let saving = $state(false);

  $effect(() => {
    if (!open) {
      return;
    }

    order = album.order ?? AssetOrder.Desc;
    activityEnabled = album.isActivityEnabled;
  });

  const save = async () => {
    saving = true;
    try {
      const updated = await handleUpdateAlbumInfo(
        album.id,
        { order, isActivityEnabled: activityEnabled },
        { message: $t('frameleaf_album_options_saved') },
      );
      if (updated) {
        onUpdated(updated);
        open = false;
      }
    } finally {
      saving = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_album_options_title')} closeLabel={$t('close')} bind:open>
  <div class="options">
    <fieldset>
      <legend>{$t('display_order')}</legend>
      <label>
        <input type="radio" name={`${groupId}-order`} value={AssetOrder.Desc} bind:group={order} />
        <span>{$t('newest_first')}</span>
      </label>
      <label>
        <input type="radio" name={`${groupId}-order`} value={AssetOrder.Asc} bind:group={order} />
        <span>{$t('oldest_first')}</span>
      </label>
    </fieldset>

    <label class="switch">
      <input type="checkbox" role="switch" bind:checked={activityEnabled} />
      <span class="switch-text">
        <strong>{$t('frameleaf_album_options_activity')}</strong>
        <small>{$t('frameleaf_album_options_activity_description')}</small>
      </span>
    </label>

    <div class="buttons">
      <button type="button" disabled={saving} onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="button" class="primary" disabled={saving} onclick={() => void save()}>{$t('save')}</button>
    </div>
  </div>
</Dialog>

<style>
  .options {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-block-start: 1rem;
    width: min(28rem, 100%);
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    border: 0;
    padding: 0;
    margin: 0;
  }
  legend {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fl-muted);
    padding: 0;
    margin-block-end: 0.25rem;
  }
  label {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .switch-text {
    display: flex;
    flex-direction: column;
  }
  .switch-text small {
    color: var(--fl-muted);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0 1rem;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .buttons .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
