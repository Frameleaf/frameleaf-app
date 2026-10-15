<script lang="ts">
  /**
   * Your preferences › Your profile (FL-368, after the approved prototype
   * `settings-v2/server/preferences.jsx`): the photo first, then name and email with their own Save,
   * and the two codes only a helper asks for behind "Details for support".
   *
   * Every change uses the account's own endpoints: `createProfileImage` / `deleteProfileImage`
   * for the photo, `updateMyUser` for colour, name and email. The colour shows whenever there is
   * no photo; choosing one does not remove a photo. A photo the server refuses leaves the current
   * avatar in place and says why.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { isProfileImageFile, PROFILE_IMAGE_EXTENSIONS } from '$lib/frameleaf/personal-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import { createProfileImage, deleteProfileImage, getMyUser, updateMyUser, UserAvatarColor } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { t, type Translations } from 'svelte-i18n';

  const user = $derived(authManager.user);
  const colors = Object.values(UserAvatarColor);
  const colorName = (color: UserAvatarColor) => $t(`frameleaf_prefs_colour_${color}` as Translations);

  let name = $state(authManager.user.name);
  let email = $state(authManager.user.email);
  let saving = $state(false);
  let photoWorking = $state(false);
  let photoError = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  const dirty = $derived(name.trim() !== user.name || email.trim() !== user.email);
  const valid = $derived(name.trim().length > 0 && email.trim().length > 0);
  const hasPhoto = $derived(!!user.profileImagePath);

  const reloadUser = async () => {
    const isCurrent = authManager.captureSession();
    const updated = await getMyUser();
    if (isCurrent()) {
      authManager.setUser(updated);
    }
  };

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
    const isCurrent = authManager.captureSession();
    try {
      await createProfileImage({ createProfileImageDto: { file } });
      if (!isCurrent()) {
        return;
      }
      await reloadUser();
      if (!isCurrent()) {
        return;
      }
      toastManager.primary($t('frameleaf_access_profile_photo_updated'));
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      photoError = getServerErrorMessage(error) ?? $t('frameleaf_access_profile_photo_failed');
    } finally {
      photoWorking = false;
    }
  };

  const removePhoto = async () => {
    const isCurrent = authManager.captureSession();
    photoWorking = true;
    photoError = '';
    try {
      await deleteProfileImage();
      if (!isCurrent()) {
        return;
      }
      await reloadUser();
      if (!isCurrent()) {
        return;
      }
      toastManager.primary($t('frameleaf_access_profile_photo_removed'));
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      handleError(error, $t('errors.unable_to_save_profile'));
    } finally {
      photoWorking = false;
    }
  };

  const setColor = async (avatarColor: UserAvatarColor) => {
    if (avatarColor === user.avatarColor) {
      return;
    }
    const isCurrent = authManager.captureSession();
    try {
      const updated = await updateMyUser({ userUpdateMeDto: { avatarColor } });
      if (isCurrent()) {
        authManager.setUser(updated);
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      handleError(error, $t('errors.unable_to_save_profile'));
    }
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving || !dirty || !valid) {
      return;
    }
    saving = true;
    const isCurrent = authManager.captureSession();
    try {
      const updated = await updateMyUser({ userUpdateMeDto: { name: name.trim(), email: email.trim() } });
      if (!isCurrent()) {
        return;
      }
      authManager.setUser(updated);
      name = updated.name;
      email = updated.email;
      toastManager.primary($t('saved_profile'));
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      handleError(error, $t('errors.unable_to_save_profile'));
    } finally {
      saving = false;
    }
  };

  let copied = $state(false);
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      copied = true;
    } catch (error) {
      handleError(error, $t('errors.unable_to_copy_to_clipboard'));
    }
  };
</script>

<KitPage>
  <Section title={$t('frameleaf_prefs_profile_photo_section')}>
    <Row label={$t('frameleaf_prefs_profile_photo')} help={$t('frameleaf_prefs_profile_photo_help')}>
      <UserAvatar {user} size="lg" noTitle />
      <Button disabled={photoWorking} onclick={() => fileInput?.click()}>
        {hasPhoto ? $t('frameleaf_prefs_profile_photo_change') : $t('frameleaf_prefs_profile_photo_upload')}
      </Button>
      {#if hasPhoto}
        <Button disabled={photoWorking} onclick={removePhoto}>{$t('frameleaf_prefs_profile_photo_remove')}</Button>
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
    </Row>
    {#if photoError}
      <p class="error" role="alert">{photoError}</p>
    {/if}
    <Row
      label={$t('frameleaf_prefs_colour')}
      help={$t(hasPhoto ? 'frameleaf_prefs_colour_help_photo' : 'frameleaf_prefs_colour_help_no_photo', {
        values: { colour: colorName(user.avatarColor) },
      })}
    >
      <div class="swatches" role="radiogroup" aria-label={$t('frameleaf_prefs_colour')}>
        {#each colors as color (color)}
          <label class="swatch" class:selected={color === user.avatarColor}>
            <input
              type="radio"
              name="avatar-color"
              value={color}
              aria-label={colorName(color)}
              checked={color === user.avatarColor}
              onchange={() => setColor(color)}
            />
            <UserAvatar user={{ ...user, profileImagePath: '', avatarColor: color }} size="md" noTitle />
          </label>
        {/each}
      </div>
    </Row>
  </Section>

  <form autocomplete="off" onsubmit={save}>
    <Section title={$t('frameleaf_prefs_profile_name_and_email')}>
      {#snippet action()}
        <Button
          disabled={saving || !dirty}
          onclick={() => {
            name = user.name;
            email = user.email;
          }}
        >
          {$t('frameleaf_prefs_profile_undo')}
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !dirty || !valid}>{$t('save')}</Button>
      {/snippet}
      <Row label={$t('frameleaf_prefs_profile_name')} help={$t('frameleaf_prefs_profile_name_help')}>
        <Field
          label={$t('frameleaf_prefs_profile_name')}
          value={name}
          disabled={saving}
          invalid={name.trim().length === 0}
          autocomplete="name"
          onChange={(value) => (name = value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_profile_email')} help={$t('frameleaf_prefs_profile_email_help')}>
        <Field
          label={$t('frameleaf_prefs_profile_email')}
          type="email"
          value={email}
          disabled={saving}
          invalid={email.trim().length === 0}
          autocomplete="email"
          onChange={(value) => (email = value)}
        />
      </Row>
      <!-- Only a helper asks for these, so they stay closed at the bottom. -->
      <Advanced summary={$t('frameleaf_prefs_profile_support')}>
        <Row label={$t('frameleaf_prefs_profile_account_id')} help={$t('frameleaf_prefs_profile_account_id_help')}>
          <code>{user.id}</code>
          <Button label={$t('frameleaf_prefs_profile_copy_label')} onclick={copyId}>
            {copied ? $t('frameleaf_documents_copied') : $t('frameleaf_prefs_profile_copy')}
          </Button>
        </Row>
        <Row label={$t('frameleaf_prefs_profile_folder')} help={$t('frameleaf_prefs_profile_folder_help')}>
          <span class="value">{user.storageLabel || $t('frameleaf_prefs_profile_folder_automatic')}</span>
        </Row>
      </Advanced>
    </Section>
  </form>
</KitPage>

<style>
  .file {
    display: none;
  }
  .error {
    margin: 0;
    padding-bottom: var(--fl-space-4);
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
    max-width: 320px;
  }
  .swatch {
    display: inline-grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 2px solid transparent;
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .swatch.selected {
    border-color: var(--fl-text);
  }
  .swatch:focus-within {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .swatch input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .value {
    font-size: var(--fl-font-callout);
  }
  @container kit (max-width: 620px) {
    .swatches {
      justify-content: flex-start;
    }
  }
</style>
