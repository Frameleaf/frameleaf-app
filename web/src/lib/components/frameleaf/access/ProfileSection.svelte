<script lang="ts">
  /**
   * Your profile, from the `profile` section of the design template's settings (`PersonalAccess`
   * header and facts, the display name and email fields): the avatar with Upload photo, Remove
   * photo and a colour, the account id and storage label, and name and email with Save.
   *
   * Every change uses the account's own endpoints: `createProfileImage` / `deleteProfileImage`
   * for the photo, `updateMyUser` for colour, name and email. The colour shows whenever there is
   * no photo; choosing one does not remove a photo. A photo the server refuses leaves the current
   * avatar in place and says why.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { isProfileImageFile, PROFILE_IMAGE_EXTENSIONS } from '$lib/frameleaf/personal-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import { createProfileImage, deleteProfileImage, getMyUser, updateMyUser, UserAvatarColor } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import './access.css';

  const user = $derived(authManager.user);
  const colors = Object.values(UserAvatarColor);

  let name = $state(authManager.user.name);
  let email = $state(authManager.user.email);
  let saving = $state(false);
  let photoWorking = $state(false);
  let photoError = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  const dirty = $derived(name.trim() !== user.name || email.trim() !== user.email);
  const valid = $derived(name.trim().length > 0 && email.trim().length > 0);
  const hasPhoto = $derived(!!user.profileImagePath);

  const reloadUser = async () => authManager.setUser(await getMyUser());

  const uploadPhoto = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }

    photoError = '';
    if (!isProfileImageFile(file)) {
      photoError = $t('frameleaf_access_profile_photo_type');
      return;
    }

    photoWorking = true;
    try {
      await createProfileImage({ createProfileImageDto: { file } });
      await reloadUser();
      toastManager.primary($t('frameleaf_access_profile_photo_updated'));
    } catch (error) {
      photoError = getServerErrorMessage(error) ?? $t('frameleaf_access_profile_photo_failed');
    } finally {
      photoWorking = false;
    }
  };

  const removePhoto = async () => {
    photoWorking = true;
    photoError = '';
    try {
      await deleteProfileImage();
      await reloadUser();
      toastManager.primary($t('frameleaf_access_profile_photo_removed'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_profile'));
    } finally {
      photoWorking = false;
    }
  };

  const setColor = async (avatarColor: UserAvatarColor) => {
    if (avatarColor === user.avatarColor) {
      return;
    }
    try {
      authManager.setUser(await updateMyUser({ userUpdateMeDto: { avatarColor } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_profile'));
    }
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving || !dirty || !valid) {
      return;
    }

    saving = true;
    try {
      const updated = await updateMyUser({ userUpdateMeDto: { name: name.trim(), email: email.trim() } });
      authManager.setUser(updated);
      name = updated.name;
      email = updated.email;
      toastManager.primary($t('saved_profile'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_profile'));
    } finally {
      saving = false;
    }
  };
</script>

<section class="fl-access-section" aria-labelledby="fl-access-profile">
  <div class="fl-access-head">
    <div>
      <p>{$t('frameleaf_access_eyebrow')}</p>
      <h3 id="fl-access-profile">{$t('frameleaf_access_profile_title')}</h3>
      <p>{user.name} · {user.email}</p>
    </div>
    <div class="avatar">
      <UserAvatar {user} size="lg" noTitle />
    </div>
  </div>

  <dl class="fl-access-facts">
    <dt>{$t('frameleaf_access_profile_account_id')}</dt>
    <dd><code>{user.id}</code></dd>
    <dt>{$t('frameleaf_access_profile_storage_label')}</dt>
    <dd>{user.storageLabel || $t('frameleaf_access_profile_storage_label_automatic')}</dd>
  </dl>

  <div class="fl-access-section">
    <h3>{$t('frameleaf_access_profile_photo')}</h3>
    <div class="fl-access-actions">
      <Button disabled={photoWorking} onclick={() => fileInput?.click()}>
        {$t('frameleaf_access_profile_photo_upload')}
      </Button>
      {#if hasPhoto}
        <Button disabled={photoWorking} onclick={removePhoto}>{$t('frameleaf_access_profile_photo_remove')}</Button>
      {/if}
      <input
        bind:this={fileInput}
        class="file"
        type="file"
        accept={PROFILE_IMAGE_EXTENSIONS.join(',')}
        tabindex="-1"
        aria-hidden="true"
        onchange={uploadPhoto}
      />
    </div>
    {#if photoError}
      <p class="fl-access-error" role="alert">{photoError}</p>
    {/if}
    <fieldset class="colors">
      <legend>{$t('frameleaf_access_profile_color')}</legend>
      <p class="fl-access-footnote">{$t('frameleaf_access_profile_color_description')}</p>
      <div class="swatches">
        {#each colors as color (color)}
          <label class="swatch" class:selected={color === user.avatarColor}>
            <input
              type="radio"
              name="avatar-color"
              value={color}
              checked={color === user.avatarColor}
              onchange={() => setColor(color)}
            />
            <UserAvatar user={{ ...user, profileImagePath: '', avatarColor: color }} size="md" label={color} noTitle />
            <span class="sr-only">{color}</span>
          </label>
        {/each}
      </div>
    </fieldset>
  </div>

  <form class="fl-access-form" autocomplete="off" onsubmit={save}>
    <label class="fl-access-field">
      <span>{$t('frameleaf_access_profile_name')}</span>
      <input required maxlength={256} disabled={saving} bind:value={name} />
    </label>
    <label class="fl-access-field">
      <span>{$t('frameleaf_access_profile_email')}</span>
      <input type="email" required disabled={saving} bind:value={email} />
    </label>
    <p class="fl-access-footnote">{$t('frameleaf_access_profile_email_description')}</p>
    <footer>
      <Button
        disabled={saving || !dirty}
        onclick={() => {
          name = user.name;
          email = user.email;
        }}
      >
        {$t('cancel')}
      </Button>
      <Button type="submit" variant="primary" disabled={saving || !dirty || !valid}>{$t('save')}</Button>
    </footer>
  </form>
</section>

<style>
  .avatar {
    flex-shrink: 0;
  }
  .file {
    display: none;
  }
  .colors {
    display: grid;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0;
    font-weight: 550;
    color: var(--fl-text);
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border: 2px solid transparent;
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .swatch.selected {
    border-color: var(--fl-accent);
  }
  .swatch:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .swatch input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
</style>
