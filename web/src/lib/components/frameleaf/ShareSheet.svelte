<script lang="ts">
  import AssetCollage from './AssetCollage.svelte';
  import Dialog from './Dialog.svelte';
  import SharedLinkForm from './SharedLinkForm.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { canSendCopies, sendCopiesWithFeedback, sendCopyPermitted } from '$lib/frameleaf/send-copy';
  import {
    canCopyImageToClipboard,
    copyAssetImageToClipboard,
    downloadArchive,
    downloadAssetFile,
    ignoreCancelledDownload,
  } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getItemShares,
    getRecipientGroups,
    searchUsers,
    shareItems,
    SharedLinkType,
    unshareItems,
    type UserResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiCheck,
    mdiContentCopy,
    mdiDownloadOutline,
    mdiExportVariant,
    mdiLinkVariant,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The share sheet for a set of items, from the prototype's `ShareSheet` (`SharedLinks.jsx:437-614`).
   *
   * FL-83 (AL-30b, owner decision 2026-09-27): two ways to share, as in the prototype. "Share with
   * people in this library" shares the items themselves with the chosen people (`/item-shares`):
   * they see them in their own Frameleaf, under Sharing › Shared with you, and are notified; nothing
   * leaves the server. It is not partner sharing, which exposes a whole library. Only the owner's own
   * items can be shared this way, so the option is offered only when every item is theirs. People
   * already sharing any selected item start selected; partial sharing is marked as such. Turning a
   * person off clears their shares across the selection. "Create a public link" opens the shared-link form.
   *
   * FL-35 / FL-54: "Send a copy…" sits beside Cancel as in the prototype (SharedLinks.jsx:477-482)
   * where the browser can share files. It hands copies of the originals to the native share sheet and
   * creates no link, so it stays separate from Frameleaf sharing.
   *
   * FL-83 AL-31: the strip above shows the items as a collage with "N items · X photos, Y videos"
   * (SharedLinks.jsx:510-517), and the shortcuts below offer "Copy image" for exactly one photo and
   * "Download" (SharedLinks.jsx:598-612), through the web client's clipboard and download helpers.
   */
  type ShareItem = { id: string; isVideo: boolean; originalFileName?: string; size?: number; ownerId?: string };
  let {
    open = $bindable(false),
    assetIds,
    assets,
    onClosed,
  }: {
    open?: boolean;
    assetIds: string[];
    /** The same items with their kind, for the count line and the shortcuts. */
    assets?: ShareItem[];
    /** Called once the sheet and the link form it opened have both closed. */
    onClosed?: () => void;
  } = $props();

  let linkFormOpen = $state(false);

  /* Share with people in this library (AL-30b) ------------------------------------------------- */
  const ownItems = $derived(
    !assets || assets.every((asset) => !asset.ownerId || asset.ownerId === authManager.user.id),
  );
  let mode = $state<'people' | 'link'>('people');
  const peopleMode = $derived(ownItems && mode === 'people');
  let people = $state<UserResponseDto[]>([]);
  let recipients = $state<Set<string>>(new Set());
  let partialRecipients = $state<Set<string>>(new Set());
  let initialRecipients = new Set<string>();
  let initialAllRecipients = new Set<string>();
  let loading = $state(false);
  let loadFailed = $state(false);
  let saving = $state(false);
  let loadedFor = $state('');
  let loadingFor = '';
  let loadId = 0;

  const loadPeople = async (key: string) => {
    if (loadedFor === key || loadingFor === key) {
      return;
    }
    const request = ++loadId;
    loadingFor = key;
    loading = true;
    loadFailed = false;
    try {
      const [users, shares, groups] = await Promise.all([
        searchUsers().catch(() => []),
        getItemShares({ itemShareQueryDto: { assetIds } }),
        // Saved people are optional; their availability must never prevent revoking an existing share.
        getRecipientGroups().catch(() => []),
      ]);
      if (request !== loadId) {
        return;
      }
      const choices = new Map([...users, ...groups.flatMap((group) => group.users)].map((user) => [user.id, user]));
      for (const { sharedWith } of shares) {
        choices.set(sharedWith.id, sharedWith);
      }
      people = [...choices.values()].filter((user) => user.id !== authManager.user.id);
      const perPerson = new Map<string, Set<string>>();
      for (const share of shares) {
        const items = perPerson.get(share.sharedWith.id) ?? new Set<string>();
        items.add(share.assetId);
        perPerson.set(share.sharedWith.id, items);
      }
      initialRecipients = new Set(perPerson.keys());
      initialAllRecipients = new Set(
        [...perPerson].filter(([, items]) => assetIds.every((id) => items.has(id))).map(([id]) => id),
      );
      recipients = new Set(initialRecipients);
      partialRecipients = new Set(without(initialRecipients, initialAllRecipients));
      loadedFor = key;
    } catch (error) {
      if (request === loadId) {
        loadFailed = true;
        handleError(error, $t('frameleaf_sharing.people_load_failed'));
      }
    } finally {
      if (request === loadId) {
        loadingFor = '';
        loading = false;
      }
    }
  };

  $effect(() => {
    const key = assetIds.join(',');
    if (open && ownItems) {
      void loadPeople(key);
    } else {
      loadId++;
      loadedFor = '';
      loadingFor = '';
      loading = false;
      loadFailed = false;
      people = [];
      recipients = new Set();
      partialRecipients = new Set();
      initialRecipients = new Set();
      initialAllRecipients = new Set();
    }
  });

  const toggle = (id: string) => {
    const next = new Set(recipients);
    if (next.has(id)) {
      next.delete(id);
      const partial = new Set(partialRecipients);
      partial.delete(id);
      partialRecipients = partial;
    } else {
      next.add(id);
    }
    recipients = next;
  };

  const chosen = $derived(people.filter((person) => recipients.has(person.id)));
  const primaryLabel = $derived(
    chosen.length === 1
      ? $t('frameleaf_sharing.share_with_person', { values: { name: chosen[0].name } })
      : chosen.length > 1
        ? $t('frameleaf_sharing.share_with_people', { values: { count: chosen.length } })
        : $t('frameleaf_sharing.save_sharing'),
  );

  /** The ids in `from` that are not in `other` (Set#difference is not in every supported browser). */
  const without = (from: Set<string>, other: Set<string>) => {
    const result: string[] = [];
    for (const id of from) {
      if (!other.has(id)) {
        result.push(id);
      }
    }
    return result;
  };

  const saveSharing = async () => {
    const savedAssetIds = [...assetIds];
    const selectionKey = savedAssetIds.join(',');
    const selectionLoadId = loadId;
    const savedRecipients = new Set(recipients);
    const savedPartialRecipients = new Set(partialRecipients);
    const isCurrentSelection = () => open && loadId === selectionLoadId && assetIds.join(',') === selectionKey;
    const toAdd = without(savedRecipients, initialAllRecipients).filter((id) => !savedPartialRecipients.has(id));
    const toRemove = without(initialRecipients, savedRecipients);
    saving = true;
    try {
      if (toAdd.length > 0) {
        await shareItems({ itemShareChangeDto: { assetIds: savedAssetIds, userIds: toAdd } });
        if (isCurrentSelection()) {
          initialRecipients = new Set([...initialRecipients, ...toAdd]);
          initialAllRecipients = new Set([...initialAllRecipients, ...toAdd]);
        }
      }
      if (toRemove.length > 0) {
        await unshareItems({ itemShareChangeDto: { assetIds: savedAssetIds, userIds: toRemove } });
      }
      if (!isCurrentSelection()) {
        return;
      }
      initialRecipients = savedRecipients;
      initialAllRecipients = new Set(without(savedRecipients, savedPartialRecipients));
      toastManager.primary($t('frameleaf_sharing.sharing_saved'));
      open = false;
    } catch (error) {
      if (isCurrentSelection()) {
        handleError(error, $t('frameleaf_sharing.sharing_save_failed'));
      }
    } finally {
      saving = false;
    }
  };

  const modeKeys = (event: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const next = mode === 'people' ? 'link' : 'people';
    mode = next;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-mode="${CSS.escape(next)}"]`)?.focus();
  };

  let wasActive = false;
  $effect(() => {
    const active = open || linkFormOpen;
    if (active) {
      wasActive = true;
    } else if (wasActive) {
      wasActive = false;
      onClosed?.();
    }
  });

  const subject = $derived(
    assetIds.length === 1
      ? assets?.[0]?.originalFileName || 'item'
      : $t('frameleaf_sharing.individual_items', { values: { count: assetIds.length } }),
  );
  const linkTarget = $derived({ type: SharedLinkType.Individual, assetIds, name: subject });

  const videos = $derived(assets?.filter((asset) => asset.isVideo).length ?? 0);
  const photos = $derived(assets ? assets.length - videos : 0);
  const countLine = $derived.by(() => {
    const items = $t('frameleaf_sharing.individual_items', { values: { count: assetIds.length } });
    if (assetIds.length < 2 || !assets) {
      return items;
    }
    const kinds = [$t('frameleaf_sharing.share_photos', { values: { count: photos } })];
    if (videos) {
      kinds.push($t('frameleaf_sharing.share_videos', { values: { count: videos } }));
    }
    return `${items} · ${kinds.join(', ')}`;
  });
  const single = $derived(assets?.length === 1 && assetIds.length === 1 ? assets[0] : undefined);
  const canCopyImage = $derived(!!single && !single.isVideo && canCopyImageToClipboard());

  const copyImage = async () => {
    if (!single) {
      return;
    }
    try {
      await copyAssetImageToClipboard(single.id);
      toastManager.primary($t('frameleaf_sharing.image_copied'));
      open = false;
    } catch (error) {
      handleError(error, $t('frameleaf_sharing.copy_image_failed'));
    }
  };

  const download = () => {
    open = false;
    if (single?.originalFileName) {
      downloadAssetFile({ id: single.id, filename: single.originalFileName, edited: true, size: single.size });
      return;
    }
    void downloadArchive('frameleaf', { assetIds }).catch(ignoreCancelledDownload);
  };

  const sendCopy = () => {
    open = false;
    void sendCopiesWithFeedback(assetIds);
  };

  const openLinkForm = () => {
    open = false;
    linkFormOpen = true;
  };
</script>

<Dialog
  title={$t('frameleaf_sharing.share_subject', { values: { subject } })}
  closeLabel={$t('close')}
  compactControls
  onkeydown={(event) => event.stopPropagation()}
  bind:open
>
  <div class="ss-strip">
    <AssetCollage ids={assetIds} class="ss-collage" />
    <span>{countLine}</span>
  </div>
  {#if ownItems}
    <div
      class="ss-options"
      role="radiogroup"
      aria-label={$t('frameleaf_sharing.how_to_share')}
      tabindex="-1"
      onkeydown={modeKeys}
    >
      <button
        type="button"
        role="radio"
        disabled={saving}
        data-mode="people"
        aria-checked={mode === 'people'}
        tabindex={mode === 'people' ? 0 : -1}
        class="ss-option"
        onclick={() => (mode = 'people')}
      >
        <Icon icon={mdiAccountMultipleOutline} size="18" aria-hidden={true} />
        <strong>{$t('frameleaf_sharing.people_option_title')}</strong>
        <small>{$t('frameleaf_sharing.people_option_description')}</small>
      </button>
      <button
        type="button"
        role="radio"
        disabled={saving}
        data-mode="link"
        aria-checked={mode === 'link'}
        tabindex={mode === 'link' ? 0 : -1}
        class="ss-option"
        onclick={() => (mode = 'link')}
      >
        <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />
        <strong>{$t('frameleaf_sharing.link_option_title')}</strong>
        <small>{$t('frameleaf_sharing.link_option_description')}</small>
      </button>
    </div>
  {/if}
  {#if peopleMode}
    {#if loading}
      <p role="status" class="ss-link-copy">{$t('loading')}</p>
    {:else if loadFailed}
      <p role="alert" class="ss-link-copy">{$t('frameleaf_sharing.people_load_failed')}</p>
      <button type="button" class="button" onclick={() => void loadPeople(assetIds.join(','))}>
        {$t('frameleaf_error_retry')}
      </button>
    {:else if people.length > 0}
      <div class="ss-people" role="group" aria-label={$t('frameleaf_sharing.people_to_share_with')}>
        {#each people as person (person.id)}
          {@const selected = recipients.has(person.id)}
          {@const partial = partialRecipients.has(person.id)}
          <button
            type="button"
            disabled={saving}
            class="ss-person"
            class:is-selected={selected}
            aria-pressed={partial ? 'mixed' : selected}
            aria-label={partial ? `${person.name}, ${$t('frameleaf_sharing.some_items_action')}` : person.name}
            onclick={() => toggle(person.id)}
          >
            <span class="ss-person-avatar" aria-hidden="true">
              <UserAvatar user={person} size="full" />
              <span class="ss-person-check"><Icon icon={mdiCheck} size="14" /></span>
            </span>
            <span class="ss-person-name" aria-hidden="true">{person.name}</span>
            {#if partial}<small>{$t('frameleaf_sharing.some_items')}</small>{/if}
          </button>
        {/each}
      </div>
    {:else}
      <p class="ss-link-copy">{$t('frameleaf_sharing.no_other_people')}</p>
    {/if}
  {:else}
    <p class="ss-link-copy">
      {ownItems ? $t('frameleaf_sharing.link_form_hint') : $t('frameleaf_sharing.link_option_description')}
    </p>
  {/if}
  <div class="ss-shortcuts">
    <button type="button" class="button" disabled={!canCopyImage} onclick={() => void copyImage()}>
      <Icon icon={mdiContentCopy} size="18" aria-hidden={true} />
      {$t('frameleaf_sharing.copy_image')}
    </button>
    <button type="button" class="button" onclick={download}>
      <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
      {$t('download')}
    </button>
  </div>
  {#snippet actions()}
    {#if canSendCopies() && sendCopyPermitted()}
      <button type="button" class="button" onclick={sendCopy}>
        <Icon icon={mdiExportVariant} size="18" aria-hidden={true} />
        {$t('frameleaf_send_copy')}
      </button>
    {/if}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    {#if peopleMode}
      <button
        type="button"
        class="button primary"
        disabled={saving || loadedFor !== assetIds.join(',')}
        onclick={() => void saveSharing()}
      >
        {primaryLabel}
      </button>
    {:else}
      <button type="button" class="button primary" onclick={openLinkForm}>
        <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />
        {$t('frameleaf_sharing.create_public_link')}
      </button>
    {/if}
  {/snippet}
</Dialog>

<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />

<style>
  .ss-strip {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 16px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .ss-strip :global(.ss-collage) {
    width: 112px;
    flex: none;
    aspect-ratio: 4 / 3;
    border-radius: var(--fl-radius-control);
  }
  .ss-shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 14px;
    border-top: 1px solid var(--fl-border);
  }
  .ss-link-copy {
    margin: 0 0 12px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.55;
  }
  .ss-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 16px;
    /* Use the approved bundled fallback on non-Apple hosts: system-ui varies by OS and can
     * wrap these compact descriptions to three lines before Inter is ever considered. */
    font-family: -apple-system, BlinkMacSystemFont, Inter, 'Segoe UI', sans-serif;
  }
  .ss-option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    text-align: start;
    background: var(--fl-panel);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 14px;
    font: inherit;
    cursor: pointer;
    transition:
      background var(--fl-motion) var(--fl-ease),
      border-color var(--fl-motion) var(--fl-ease);
  }
  .ss-option :global(svg) {
    color: var(--fl-muted);
  }
  .ss-option strong {
    font-weight: 560;
    font-size: var(--fl-font-size);
  }
  .ss-option small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .ss-option:hover {
    background: var(--fl-raised);
  }
  .ss-option[aria-checked='true'] {
    background: var(--fl-raised);
    border-color: var(--fl-accent);
  }
  .ss-option[aria-checked='true'] :global(svg) {
    color: var(--fl-accent);
  }
  .ss-people {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 8px;
    margin: 18px 0 6px;
    max-height: 16rem;
    overflow-y: auto;
  }
  .ss-person {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    padding: 12px 8px 10px;
    border-radius: var(--fl-radius-card);
    border: 1px solid transparent;
    background: transparent;
    color: var(--fl-muted);
    transition:
      background var(--fl-motion-fast) var(--fl-ease),
      border-color var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  .ss-person:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .ss-person.is-selected {
    background: var(--fl-accent-soft);
    border-color: color-mix(in srgb, var(--fl-accent) 55%, transparent);
    color: var(--fl-text);
  }
  .ss-person-avatar {
    position: relative;
    display: inline-flex;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    transition: box-shadow var(--fl-motion-fast) var(--fl-ease);
  }
  .ss-person.is-selected .ss-person-avatar {
    box-shadow:
      0 0 0 3px var(--fl-panel),
      0 0 0 5px var(--fl-accent);
  }
  .ss-person-check {
    position: absolute;
    right: -3px;
    bottom: -3px;
    display: none;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border: 2px solid var(--fl-panel);
  }
  .ss-person.is-selected .ss-person-check {
    display: grid;
  }
  .ss-person-name {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
    text-align: center;
  }
  @media (max-width: 480px) {
    .ss-options {
      grid-template-columns: 1fr;
    }
  }
</style>
