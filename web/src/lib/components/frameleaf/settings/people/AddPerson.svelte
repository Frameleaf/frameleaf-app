<script lang="ts">
  /**
   * "Add a person" (FL-516, after the prototype's form in `settings-v2/cloud/People.jsx`), as a page
   * of its own: name, email, role, space (starting from "Space for new people"), and how they first
   * sign in.
   *
   * How they first sign in: with email set up, a single-use link to choose their own password (FL-538,
   * the prototype's default; you never see it); a temporary password Frameleaf makes up and shows you
   * once, which they must change the first time (with an optional email of their sign-in details); or,
   * when a sign-in provider is set up, signing in with it (no password at all).
   *
   * Their colour (FL-538): shown behind their initial until they add a picture; they can change it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import SpacePicker from '$lib/components/frameleaf/settings/people/SpacePicker.svelte';
  import { bytesOfGb, spaceWords } from '$lib/components/frameleaf/settings/people/space';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleCreateUserAdmin } from '$lib/services/user-admin.service';
  import { copyToClipboard } from '$lib/utils';
  import { getConfig, UserAvatarColor, type UserAdminResponseDto } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { onDone }: { onDone: (created?: UserAdminResponseDto) => void } = $props();

  /** Letters and digits that cannot be misread for one another. */
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const makePassword = () =>
    [...crypto.getRandomValues(new Uint32Array(14))].map((value) => ALPHABET[value % ALPHABET.length]).join('');

  let name = $state('');
  let email = $state('');
  let isAdmin = $state(false);
  let space = $state<number | null>(null);
  let storageLabel = $state('');
  type First = 'link' | 'password' | 'provider';
  const emailOn = $derived(featureFlagsManager.value.email);
  let chosenFirst = $state<First>();
  /** The prototype starts on "Email them a link"; without email set up, on a temporary password. */
  const first = $derived<First>(chosenFirst ?? (emailOn ? 'link' : 'password'));
  /** The prototype's colours, in its order; "Green" first, as it starts. */
  const COLOURS = [
    [UserAvatarColor.Green, 'frameleaf_userpage_colour_green'],
    [UserAvatarColor.Blue, 'frameleaf_userpage_colour_blue'],
    [UserAvatarColor.Purple, 'frameleaf_userpage_colour_purple'],
    [UserAvatarColor.Pink, 'frameleaf_userpage_colour_pink'],
    [UserAvatarColor.Red, 'frameleaf_userpage_colour_red'],
    [UserAvatarColor.Orange, 'frameleaf_userpage_colour_orange'],
    [UserAvatarColor.Yellow, 'frameleaf_userpage_colour_yellow'],
    [UserAvatarColor.Gray, 'frameleaf_userpage_colour_grey'],
  ] as const;
  let colour = $state<UserAvatarColor>(UserAvatarColor.Green);
  let notify = $state(false);
  let saving = $state(false);
  /** After adding: who, and the temporary password to pass on (shown once). */
  let added = $state<{ user: UserAdminResponseDto; password?: string; link?: boolean }>();
  let copied = $state(false);

  const providerOn = $derived(featureFlagsManager.value.oauth);
  const valid = $derived(name.trim().length > 0 && email.includes('@'));

  onMount(() => {
    void (async () => {
      try {
        space = (await getConfig()).user.newUserStorageQuota ?? null;
      } catch {
        // stays "No limit"; the server applies "Space for new people" only when nothing is chosen
      }
    })();
  });

  const add = async () => {
    saving = true;
    try {
      const password = first === 'password' ? makePassword() : undefined;
      const user = await handleCreateUserAdmin({
        name: name.trim(),
        email: email.trim(),
        isAdmin,
        avatarColor: colour,
        quotaSizeInBytes: bytesOfGb(space),
        storageLabel: storageLabel.trim() || null,
        // with a link or a sign-in provider no password is set: the server accepts an empty one only then
        password: password ?? '',
        ...(password && { shouldChangePassword: true, notify }),
        ...(first === 'link' && { passwordLink: true }),
      });
      if (user) {
        added = { user, password, link: first === 'link' };
      }
    } finally {
      saving = false;
    }
  };
</script>

<KitPage>
  {#if added}
    <Section title={$t('frameleaf_userpage_added', { values: { name: added.user.name } })}>
      {#if added.password}
        <Notice tone="warn" title={$t('frameleaf_userpage_added_password')}>
          {$t('frameleaf_userpage_added_password_body', { values: { name: added.user.name } })}
          {#snippet action()}
            <Button
              onclick={async () => {
                copied = await copyToClipboard(added?.password);
              }}
            >
              {copied ? $t('frameleaf_userpage_copied') : $t('frameleaf_userpage_copy')}
            </Button>
          {/snippet}
        </Notice>
        <p class="password"><code>{added.password}</code></p>
      {:else if added.link}
        <p class="hint">{$t('frameleaf_userpage_added_link', { values: { email: added.user.email } })}</p>
      {:else}
        <p class="hint">{$t('frameleaf_userpage_added_provider', { values: { email: added.user.email } })}</p>
      {/if}
      <div class="actions">
        <Button variant="primary" onclick={() => onDone(added?.user)}>{$t('frameleaf_userpage_open_person')}</Button>
        <Button onclick={() => onDone()}>{$t('frameleaf_userpage_back_to_users')}</Button>
      </div>
    </Section>
  {:else}
    <Section title={$t('frameleaf_userpage_add_title')} description={$t('frameleaf_userpage_add_description')}>
      <Row label={$t('frameleaf_userpage_name')}>
        <Field
          label={$t('frameleaf_userpage_name')}
          value={name}
          placeholder="Alex"
          onChange={(value) => (name = value)}
        />
      </Row>
      <Row label={$t('frameleaf_userpage_email')} help={$t('frameleaf_userpage_email_help')}>
        <Field
          wide
          type="email"
          label={$t('frameleaf_userpage_email')}
          value={email}
          placeholder="alex@example.test"
          onChange={(value) => (email = value)}
        />
      </Row>
      <Row label={$t('frameleaf_userpage_role')} help={$t('frameleaf_userpage_role_help')}>
        <SegmentedControl
          label={$t('frameleaf_userpage_role')}
          value={isAdmin ? 'admin' : 'member'}
          options={[
            { value: 'member', label: $t('frameleaf_userpage_role_member') },
            { value: 'admin', label: $t('frameleaf_userpage_role_admin') },
          ]}
          onChange={(value) => (isAdmin = value === 'admin')}
        />
      </Row>
      <Row
        label={$t('frameleaf_userpage_space')}
        help={$t('frameleaf_userpage_space_add_help', {
          values: { space: space === null ? $t('frameleaf_userpage_space_none') : spaceWords(space) },
        })}
      >
        <SpacePicker
          label={$t('frameleaf_userpage_space_for_new')}
          value={space}
          onChange={(value) => (space = value)}
        />
      </Row>
      <Row
        label={$t('frameleaf_userpage_first')}
        help={first === 'link'
          ? $t('frameleaf_userpage_first_link_help')
          : first === 'password'
            ? $t('frameleaf_userpage_first_password_help')
            : $t('frameleaf_userpage_first_provider_help')}
      >
        <SegmentedControl
          label={$t('frameleaf_userpage_first')}
          value={first}
          options={[
            ...(emailOn ? [{ value: 'link', label: $t('frameleaf_userpage_first_link') }] : []),
            { value: 'password', label: $t('frameleaf_userpage_first_password') },
            ...(providerOn ? [{ value: 'provider', label: $t('frameleaf_userpage_first_provider') }] : []),
          ]}
          onChange={(value) => (chosenFirst = value as First)}
        />
      </Row>
      {#if first === 'password'}
        <Row label={$t('frameleaf_userpage_notify')} help={$t('frameleaf_userpage_notify_help')}>
          <Switch label={$t('frameleaf_userpage_notify')} checked={notify} onChange={(value) => (notify = value)} />
        </Row>
      {/if}
      <Row label={$t('frameleaf_userpage_colour')} help={$t('frameleaf_userpage_colour_help')}>
        <div class="swatches" role="group" aria-label={$t('frameleaf_userpage_colour')}>
          {#each COLOURS as [value, key] (value)}
            <button
              type="button"
              aria-label={$t(key)}
              title={$t(key)}
              aria-pressed={colour === value}
              onclick={() => (colour = value)}
            >
              <UserAvatar
                user={{
                  id: '',
                  name: name.trim() || '?',
                  email: '',
                  profileImagePath: '',
                  avatarColor: value,
                  profileChangedAt: '',
                }}
                size="sm"
                noTitle
              />
            </button>
          {/each}
        </div>
      </Row>
      <Advanced summary={$t('frameleaf_userpage_advanced')}>
        <Row label={$t('frameleaf_userpage_folder')} help={$t('frameleaf_userpage_folder_add_help')}>
          <Field
            label={$t('frameleaf_userpage_folder')}
            value={storageLabel}
            placeholder="alex"
            onChange={(value) => (storageLabel = value)}
          />
        </Row>
      </Advanced>
      <div class="actions">
        <Button variant="primary" disabled={!valid || saving} onclick={add}
          >{$t('frameleaf_userpage_add_button')}</Button
        >
        <Button disabled={saving} onclick={() => onDone()}>{$t('cancel')}</Button>
      </div>
    </Section>
  {/if}
</KitPage>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
  }
  .password code {
    display: inline-block;
    padding: var(--fl-space-2) var(--fl-space-3);
    font-size: var(--fl-font-callout);
    letter-spacing: 0.04em;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .swatches button {
    padding: 2px;
    background: none;
    border: 2px solid transparent;
    border-radius: 50%;
    cursor: pointer;
  }
  .swatches button[aria-pressed='true'] {
    border-color: var(--fl-accent);
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
</style>
