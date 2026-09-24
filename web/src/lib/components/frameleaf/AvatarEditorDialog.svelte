<script lang="ts">
  /**
   * Edit avatar (S-2): the prototype's `AvatarEditor` (`design/frameleaf/template/src/SystemPanels.jsx:
   * 446-626`) in place of the legacy colour-only `AvatarEditModal` — choose one of your recent photos,
   * reposition it by dragging or with the arrow keys (Shift for bigger steps), zoom, or pick a colour
   * instead; Cancel / Save avatar.
   *
   * Saving a photo draws the framed crop onto a canvas and uploads it as the profile picture with the
   * photo recorded (`createProfileImage`), as "Set as profile picture" does, so the picture is replaced
   * if that photo is later Locked. Saving a colour removes any profile picture and sets the colour.
   *
   * Privacy: profile pictures are shown to every account, so the choices are only this account's own
   * timeline photos (a timeline search also returns partners' photos, which are dropped; the server
   * refuses another account's photo too), and none are offered while this session reveals Locked
   * content. Re-cropping the current picture keeps the photo it was copied from (`keepSource`).
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl, getProfileImageUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetOrder,
    AssetTypeEnum,
    AssetVisibility,
    createProfileImage,
    deleteProfileImage,
    searchAssets,
    updateMyUser,
    UserAvatarColor,
    type AssetResponseDto,
  } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = { onClose: () => void };
  const { onClose }: Props = $props();

  const OUTPUT_SIZE = 512;
  const PHOTO_COUNT = 8;
  /** A timeline search includes partners' photos; read more so up to eight of the account's own remain. */
  const SEARCH_SIZE = 48;

  let open = $state(true);
  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  type Choice = { id: string; src: string; name: string; assetId?: string };

  const user = authManager.user;
  const current: Choice | undefined = user.profileImagePath
    ? { id: 'current', src: getProfileImageUrl(user), name: $t('frameleaf_avatar_current_photo') }
    : undefined;

  let photos = $state<Choice[]>([]);
  let mode = $state<'photo' | 'color'>(current ? 'photo' : 'color');
  let selected = $state<Choice | undefined>(current);
  let color = $state<UserAvatarColor>(user.avatarColor);
  let zoom = $state(1);
  let offset = $state({ x: 0, y: 0 });
  let saving = $state(false);
  let image = $state<HTMLImageElement>();
  const zoomId = $props.id();

  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  const move = (x: number, y: number) => {
    const limit = (zoom - 1) * 50;
    offset = { x: clamp(x, limit), y: clamp(y, limit) };
  };

  onMount(async () => {
    if (sessionAccess.isElevated) {
      return;
    }
    try {
      const { assets } = await searchAssets({
        metadataSearchDto: {
          type: AssetTypeEnum.Image,
          visibility: AssetVisibility.Timeline,
          order: AssetOrder.Desc,
          size: SEARCH_SIZE,
        },
      });
      photos = assets.items
        .filter((asset: AssetResponseDto) => asset.ownerId === user.id)
        .slice(0, PHOTO_COUNT)
        .map((asset: AssetResponseDto) => ({
          id: asset.id,
          assetId: asset.id,
          name: asset.originalFileName,
          src: getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
        }));
      if (!selected && photos.length > 0 && mode === 'photo') {
        selected = photos[0];
      }
    } catch {
      // The colour choice still works without photos.
    }
  });

  const choosePhoto = (choice: Choice) => {
    mode = 'photo';
    selected = choice;
    zoom = 1;
    offset = { x: 0, y: 0 };
  };

  let drag: { x: number; y: number; ox: number; oy: number } | undefined;
  const onpointerdown = (event: PointerEvent) => {
    if (mode !== 'photo') {
      return;
    }
    drag = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onpointermove = (event: PointerEvent) => {
    if (!drag) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    move(
      drag.ox + ((event.clientX - drag.x) / rect.width) * 100,
      drag.oy + ((event.clientY - drag.y) / rect.height) * 100,
    );
  };
  const onpointerup = () => (drag = undefined);
  const onkeydown = (event: KeyboardEvent) => {
    if (mode !== 'photo') {
      return;
    }
    const step = event.shiftKey ? 10 : 2;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = moves[event.key];
    if (!delta) {
      return;
    }
    event.preventDefault();
    move(offset.x + delta[0], offset.y + delta[1]);
  };

  const onZoom = (value: number) => {
    zoom = value;
    move(offset.x, offset.y);
  };

  /** Draws the framed crop exactly as the preview shows it: object-fit cover, then translate and scale. */
  const renderCrop = async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not get canvas context.');
    }
    const cover = Math.max(OUTPUT_SIZE / img.naturalWidth, OUTPUT_SIZE / img.naturalHeight);
    const width = img.naturalWidth * cover;
    const height = img.naturalHeight * cover;
    context.fillStyle = '#000';
    context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    context.translate(
      OUTPUT_SIZE / 2 + (offset.x / 100) * OUTPUT_SIZE,
      OUTPUT_SIZE / 2 + (offset.y / 100) * OUTPUT_SIZE,
    );
    context.scale(zoom, zoom);
    context.drawImage(img, -width / 2, -height / 2, width, height);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the avatar.'))), 'image/png'),
    );
  };

  const save = async () => {
    if (saving) {
      return;
    }
    saving = true;
    try {
      if (mode === 'color') {
        if (user.profileImagePath !== '') {
          await deleteProfileImage();
        }
        authManager.setUser(await updateMyUser({ userUpdateMeDto: { avatarColor: color } }));
      } else if (selected && image) {
        const unchanged = selected.id === 'current' && zoom === 1 && offset.x === 0 && offset.y === 0;
        if (!unchanged) {
          const blob = await renderCrop(image);
          const file = new File([blob], 'profile-picture.png', { type: 'image/png' });
          await createProfileImage({
            createProfileImageDto: selected.assetId ? { file, assetId: selected.assetId } : { file, keepSource: true },
          });
          await authManager.refresh();
        }
      }
      toastManager.primary($t('saved_profile'));
      open = false;
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_profile'));
    } finally {
      saving = false;
    }
  };

  const colors = Object.values(UserAvatarColor);
  const initial = (user.name ?? '?').trim().charAt(0).toUpperCase();
</script>

<Dialog title={$t('edit_avatar')} closeLabel={$t('close')} bind:open>
  <div class="avatar-editor">
    <div class="avatar-stage">
      <!-- The crop is an image that can be moved by pointer or arrow keys, as the prototype's is. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="avatar-crop"
        role="img"
        aria-label={mode === 'photo'
          ? $t('frameleaf_avatar_preview_photo')
          : $t('frameleaf_avatar_preview_color', { values: { letter: initial } })}
        tabindex="0"
        {onpointerdown}
        {onpointermove}
        {onpointerup}
        onpointercancel={onpointerup}
        {onkeydown}
      >
        {#if mode === 'photo' && selected}
          <img
            bind:this={image}
            src={selected.src}
            alt=""
            draggable="false"
            crossorigin="use-credentials"
            style:transform="translate({offset.x}%, {offset.y}%) scale({zoom})"
          />
        {:else}
          <UserAvatar user={{ ...user, profileImagePath: '', avatarColor: color }} size="full" noTitle />
        {/if}
      </div>
      {#if mode === 'photo'}
        <label class="avatar-zoom" for={zoomId}>
          {$t('frameleaf_avatar_zoom')}
          <input
            id={zoomId}
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={zoom}
            oninput={(event) => onZoom(Number((event.currentTarget as HTMLInputElement).value))}
          />
        </label>
      {/if}
    </div>
    <div class="avatar-choices">
      <div>
        <h3>{$t('frameleaf_avatar_choose_photo')}</h3>
        {#if sessionAccess.isElevated}
          <p class="note">{$t('frameleaf_avatar_photos_locked')}</p>
        {:else}
          <div class="avatar-grid" role="group" aria-label={$t('frameleaf_avatar_photos')}>
            {#each current ? [current, ...photos] : photos as choice, index (choice.id)}
              <button
                type="button"
                aria-label={choice.name}
                aria-pressed={mode === 'photo' && selected?.id === choice.id}
                data-initial-focus={index === 0 ? '' : undefined}
                onclick={() => choosePhoto(choice)}
              >
                <img src={choice.src} alt="" loading="lazy" />
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div>
        <h3>{$t('frameleaf_avatar_or_color')}</h3>
        <div class="avatar-colors" role="group" aria-label={$t('frameleaf_avatar_colors')}>
          {#each colors as value (value)}
            <button
              type="button"
              aria-label={value}
              aria-pressed={mode === 'color' && color === value}
              onclick={() => {
                mode = 'color';
                color = value;
              }}
            >
              <UserAvatar user={{ ...user, profileImagePath: '', avatarColor: value }} size="sm" noTitle />
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button
      type="button"
      class="button primary"
      disabled={saving || (mode === 'photo' && !selected)}
      onclick={() => void save()}
    >
      {$t('frameleaf_avatar_save')}
    </button>
  {/snippet}
</Dialog>

<style>
  /* design/frameleaf/template/src/system.css `.avatar-*`. */
  .avatar-editor {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 20px;
  }
  .avatar-stage {
    display: grid;
    gap: 12px;
    justify-items: center;
    align-content: start;
  }
  .avatar-crop {
    width: 180px;
    height: 180px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--fl-raised);
    position: relative;
    touch-action: none;
    cursor: grab;
    outline-offset: 4px;
    display: grid;
    place-items: center;
  }
  .avatar-crop:active {
    cursor: grabbing;
  }
  .avatar-crop img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform-origin: center;
    user-select: none;
    pointer-events: none;
  }
  .avatar-zoom {
    display: grid;
    gap: 4px;
    width: 100%;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .avatar-zoom input {
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    accent-color: var(--fl-accent);
  }
  .avatar-choices {
    display: grid;
    gap: 14px;
    align-content: start;
  }
  .avatar-choices h3 {
    margin: 0 0 8px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    font-weight: 500;
  }
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .avatar-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .avatar-grid button {
    aspect-ratio: 1;
    border-radius: var(--fl-radius-control);
    overflow: hidden;
    padding: 0;
    border: 2px solid transparent;
    background: var(--fl-raised);
  }
  .avatar-grid button img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .avatar-grid button[aria-pressed='true'] {
    border-color: var(--fl-accent);
  }
  .avatar-colors {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .avatar-colors button {
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
    background: none;
  }
  .avatar-colors button[aria-pressed='true'] {
    border-color: var(--fl-accent);
  }
  @media (max-width: 700px) {
    .avatar-editor {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
