<script lang="ts">
  /**
   * "Add a person" (FL-516, after the prototype's form in `settings-v2/cloud/People.jsx`), as a page
   * of its own: name, email, role, space (starting from "Space for new people"), and how they first
   * sign in.
   *
   * How they first sign in: a temporary password Frameleaf makes up and shows you once, which they
   * must change the first time (with an optional email of their sign-in details), or, when a sign-in
   * provider is set up, signing in with it (no password at all). The prototype's "Email them a link to
   * choose a password" needs a set-password link the server does not send yet; it is a follow-up.
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
  import SpacePicker from '$lib/components/frameleaf/settings/people/SpacePicker.svelte';
  import { bytesOfGb, spaceWords } from '$lib/components/frameleaf/settings/people/space';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleCreateUserAdmin } from '$lib/services/user-admin.service';
  import { copyToClipboard } from '$lib/utils';
  import { getConfig, type UserAdminResponseDto } from '@frameleaf/sdk';
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
  let first = $state<'password' | 'provider'>('password');
  let notify = $state(false);
  let saving = $state(false);
  /** After adding: who, and the temporary password to pass on (shown once). */
  let added = $state<{ user: UserAdminResponseDto; password?: string }>();
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
        quotaSizeInBytes: bytesOfGb(space),
        storageLabel: storageLabel.trim() || null,
        // with a sign-in provider no password is set: the server accepts an empty one only then
        password: password ?? '',
        ...(password && { shouldChangePassword: true, notify }),
      });
      if (user) {
        added = { user, password };
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
        help={first === 'password'
          ? $t('frameleaf_userpage_first_password_help')
          : $t('frameleaf_userpage_first_provider_help')}
      >
        <SegmentedControl
          label={$t('frameleaf_userpage_first')}
          value={first}
          options={[
            { value: 'password', label: $t('frameleaf_userpage_first_password') },
            ...(providerOn ? [{ value: 'provider', label: $t('frameleaf_userpage_first_provider') }] : []),
          ]}
          onChange={(value) => (first = value === 'provider' ? 'provider' : 'password')}
        />
      </Row>
      {#if first === 'password'}
        <Row label={$t('frameleaf_userpage_notify')} help={$t('frameleaf_userpage_notify_help')}>
          <Switch label={$t('frameleaf_userpage_notify')} checked={notify} onChange={(value) => (notify = value)} />
        </Row>
      {/if}
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
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
</style>
