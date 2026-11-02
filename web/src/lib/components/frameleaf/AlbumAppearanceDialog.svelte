<script lang="ts">
  import AlbumColorChoice from '$lib/components/frameleaf/AlbumColorChoice.svelte';
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconChooser from '$lib/components/frameleaf/IconChooser.svelte';
  import { defaultIconFor } from '$lib/frameleaf/album-directory';
  import { albumColor, albumColorSpec, type AlbumColor } from '$lib/frameleaf/album-tree';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * "Icon and colour…" for an album or collection (prototype `AppearanceDialog`, README point 22):
   * a live preview, the colour choice, the icon chooser over the whole catalogue and "Use the plain
   * folder", which clears both. Saving sends `icon` and `color` together through the caller.
   */
  interface Props {
    album: AlbumResponseDto;
    hasChildren?: boolean;
    open?: boolean;
    onSave: (appearance: { icon: string | null; color: AlbumColor | null }) => Promise<boolean>;
  }

  let { album, hasChildren = false, open = $bindable(false), onSave }: Props = $props();

  let icon = $state<string | null>(null);
  let color = $state<AlbumColor | null>(null);
  let busy = $state(false);

  $effect(() => {
    if (open) {
      untrack(() => {
        icon = album.icon ?? null;
        color = albumColor(album.color);
      });
    }
  });

  const colorSpec = $derived(albumColorSpec(color));
  const name = $derived(album.albumName || $t('unnamed_album'));
  const fallbackIcon = $derived(hasChildren ? 'mdiFolderMultipleOutline' : defaultIconFor(album.kind));

  const save = async () => {
    busy = true;
    try {
      if (await onSave({ icon, color })) {
        open = false;
      }
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_album_color_dialog_title')} closeLabel={$t('close')} bind:open>
  <div class="appearance">
    <div class="preview" data-testid="appearance-preview">
      <AlbumMark {icon} {color} kind={album.kind} {hasChildren} size="20" />
      <span>{name}</span>
      <span class="sr-only">
        {colorSpec
          ? $t('frameleaf_album_color_preview', { values: { color: $t(colorSpec.labelKey) } })
          : $t('frameleaf_album_color_none')}
      </span>
    </div>
    <AlbumColorChoice value={color} onChange={(next) => (color = next)} name="album-appearance-color" />
    <div class="icons">
      <span class="label">{$t('icon')}</span>
      <IconChooser
        value={icon ?? fallbackIcon}
        onChange={(next) => (icon = next)}
        inline
        label={$t('frameleaf_album_icon_for', { values: { name } })}
      />
    </div>
    <p class="note">{$t('frameleaf_album_color_shared_note')}</p>
  </div>
  {#snippet actions()}
    <button
      type="button"
      class="button"
      disabled={busy || (icon === null && color === null)}
      onclick={() => {
        icon = null;
        color = null;
      }}>{$t('frameleaf_album_color_plain')}</button
    >
    <span class="spacer"></span>
    <button type="button" class="button" disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="button" class="button primary" disabled={busy} onclick={() => void save()}>{$t('save')}</button>
  {/snippet}
</Dialog>

<style>
  .appearance {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    width: min(32rem, 100%);
  }
  .preview {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    align-self: flex-start;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.875rem;
    font-weight: 600;
  }
  .icons {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
  }
  .label {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.8125rem);
  }
  .spacer {
    flex: 1;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
