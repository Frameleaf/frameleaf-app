<script lang="ts">
  /**
   * One person (FL-516, after the prototype's `Person` in `settings-v2/cloud/People.jsx`), in three
   * parts in place of seven tabs:
   *
   * - **About**: name, email, role and the space they have (a short list with "Other…"), saved together.
   * - **Sign-in & security**: helping someone back in (a temporary password, clearing their PIN,
   *   signing out their devices) through `AccountSecurityPanel`. Their password, PIN and Locked photos
   *   are never shown.
   * - **What they've turned on**: their own choices as a summary, read-only, with "Change for them…"
   *   (after a confirmation) opening the editor `AccountPreferencesEditor` as before. Account ID and the
   *   folder name on disk are under Advanced, with the account's recent changes.
   *
   * Then removing them, which says what happens and when (`AccountLifecyclePanel`).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import AccountLifecyclePanel from '$lib/components/frameleaf/AccountLifecyclePanel.svelte';
  import AccountPreferencesEditor from '$lib/components/frameleaf/AccountPreferencesEditor.svelte';
  import AccountSecurityPanel from '$lib/components/frameleaf/AccountSecurityPanel.svelte';
  import DesktopMemberApproval from '$lib/components/frameleaf/DesktopMemberApproval.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import SpacePicker from '$lib/components/frameleaf/settings/people/SpacePicker.svelte';
  import { bytesOfGb, gbOfBytes, gibWords, spaceWords } from '$lib/components/frameleaf/settings/people/space';
  import { accountLifecycle, canChangeRole } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleUpdateUserAdmin } from '$lib/services/user-admin.service';
  import { copyToClipboard } from '$lib/utils';
  import type {
    SessionResponseDto,
    UserAdminResponseDto,
    UserPreferencesResponseDto,
    UserPreferencesUpdateDto,
  } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    user: UserAdminResponseDto;
    preferences: UserPreferencesResponseDto;
    sessions: SessionResponseDto[];
    savePreferences: (update: UserPreferencesUpdateDto) => Promise<UserPreferencesResponseDto>;
    loadPreferences: () => Promise<UserPreferencesResponseDto>;
    onPreferencesSaved?: () => void;
    onOpenPrivacy?: () => void;
  };
  let { user, preferences, sessions, savePreferences, loadPreferences, onPreferencesSaved, onOpenPrivacy }: Props =
    $props();

  const live = $derived(accountLifecycle(user) === 'active');
  const selfId = $derived(authManager.authenticated ? authManager.user.id : undefined);
  const isSelf = $derived(selfId === user.id);

  // ---- About: one form, saved together ----
  let name = $state('');
  let email = $state('');
  let isAdmin = $state(false);
  let space = $state<number | null>(null);
  let storageLabel = $state('');
  let saving = $state(false);
  const reset = () => {
    name = user.name;
    email = user.email;
    isAdmin = user.isAdmin;
    space = gbOfBytes(user.quotaSizeInBytes);
    storageLabel = user.storageLabel ?? '';
  };
  $effect.pre(() => {
    void user;
    reset();
  });
  const changed = $derived(
    name !== user.name ||
      email !== user.email ||
      isAdmin !== user.isAdmin ||
      space !== gbOfBytes(user.quotaSizeInBytes) ||
      storageLabel !== (user.storageLabel ?? ''),
  );
  const valid = $derived(name.trim().length > 0 && email.includes('@'));

  const save = async () => {
    saving = true;
    try {
      await handleUpdateUserAdmin(user, {
        ...(name !== user.name && { name: name.trim() }),
        ...(email !== user.email && { email: email.trim() }),
        ...(isAdmin !== user.isAdmin && { isAdmin }),
        ...(space !== gbOfBytes(user.quotaSizeInBytes) && { quotaSizeInBytes: bytesOfGb(space) }),
        ...(storageLabel !== (user.storageLabel ?? '') && { storageLabel: storageLabel.trim() || null }),
      });
    } finally {
      saving = false;
    }
  };

  // ---- Pause new uploads: saved as soon as it is switched (FL-538) ----
  let pausing = $state(false);
  // follows the saved choice, and shows a switch at once while it saves
  let paused = $derived(user.uploadsPaused);
  const setPaused = async (next: boolean) => {
    paused = next;
    pausing = true;
    try {
      if (!(await handleUpdateUserAdmin(user, { uploadsPaused: next }))) {
        paused = user.uploadsPaused;
      }
    } finally {
      pausing = false;
    }
  };

  const usedGb = $derived(gbOfBytes(user.quotaUsageInBytes ?? 0) ?? 0);
  /** An older account's whole-GiB quota, kept as its own choice until it is changed. */
  const kept = $derived.by(() => {
    const label = user.quotaSizeInBytes ? gibWords(user.quotaSizeInBytes) : undefined;
    return label ? { gb: gbOfBytes(user.quotaSizeInBytes)!, label } : undefined;
  });
  const spaceHelp = $derived.by(() => {
    const limit = gbOfBytes(user.quotaSizeInBytes);
    const used = spaceWords(usedGb);
    if (limit === null) {
      return $t('frameleaf_userpage_space_help_none', { values: { name: user.name, used } });
    }
    const limitWords = kept?.label ?? spaceWords(limit);
    return limit > usedGb
      ? $t('frameleaf_userpage_space_help', {
          values: { name: user.name, used, limit: limitWords, free: spaceWords(limit - usedGb) },
        })
      : $t('frameleaf_userpage_space_help_full', { values: { name: user.name, used, limit: limitWords } });
  });

  // ---- What they've turned on: a summary, and the editor only on request ----
  let changing = $state(false);
  let confirming = $state(false);
  const onOff = (on: boolean | undefined) => (on ? $t('frameleaf_userpage_on') : $t('frameleaf_userpage_off'));
  const facts = $derived([
    {
      label: $t('frameleaf_userpage_fact_memories'),
      value: onOff(preferences.memories?.enabled),
    },
    {
      label: $t('frameleaf_userpage_fact_people'),
      value: onOff(preferences.people?.enabled),
    },
    {
      label: $t('frameleaf_userpage_fact_extras'),
      value:
        [
          preferences.folders?.enabled && $t('frameleaf_userpage_fact_folders'),
          preferences.tags?.enabled && $t('frameleaf_userpage_fact_tags'),
          preferences.ratings?.enabled && $t('frameleaf_userpage_fact_ratings'),
        ]
          .filter(Boolean)
          .join(', ') || $t('frameleaf_userpage_off'),
    },
    {
      label: $t('frameleaf_userpage_fact_emails'),
      value: preferences.emailNotifications?.enabled
        ? [
            preferences.emailNotifications.albumInvite && $t('frameleaf_userpage_fact_album_invites'),
            preferences.emailNotifications.albumUpdate && $t('frameleaf_userpage_fact_album_updates'),
          ]
            .filter(Boolean)
            .join(', ') || $t('frameleaf_userpage_on')
        : $t('frameleaf_userpage_off'),
    },
  ]);

  let copied = $state(false);
  const copyId = async () => {
    await copyToClipboard(user.id);
    copied = true;
  };
</script>

<KitPage>
  <Section title={$t('frameleaf_userpage_about')}>
    <Row label={$t('frameleaf_userpage_name')}>
      <Field label={$t('frameleaf_userpage_name')} value={name} disabled={!live} onChange={(value) => (name = value)} />
    </Row>
    <Row label={$t('frameleaf_userpage_email')} help={$t('frameleaf_userpage_email_help')}>
      <Field
        wide
        type="email"
        label={$t('frameleaf_userpage_email')}
        value={email}
        disabled={!live}
        onChange={(value) => (email = value)}
      />
    </Row>
    <Row
      label={$t('frameleaf_userpage_role')}
      help={isSelf ? $t('frameleaf_userpage_role_self') : $t('frameleaf_userpage_role_help')}
    >
      <SegmentedControl
        label={$t('frameleaf_userpage_role')}
        value={isAdmin ? 'admin' : 'member'}
        disabled={!live || !canChangeRole(user, selfId ?? '')}
        options={[
          { value: 'member', label: $t('frameleaf_userpage_role_member') },
          { value: 'admin', label: $t('frameleaf_userpage_role_admin') },
        ]}
        onChange={(value) => (isAdmin = value === 'admin')}
      />
    </Row>
    <Row label={$t('frameleaf_userpage_space')} help={spaceHelp}>
      <SpacePicker
        label={$t('frameleaf_userpage_space_for', { values: { name: user.name } })}
        value={space}
        {kept}
        disabled={!live}
        onChange={(value) => (space = value)}
      />
    </Row>
    <Row label={$t('frameleaf_userpage_pause')} help={$t('frameleaf_userpage_pause_help')}>
      <Switch
        label={$t('frameleaf_userpage_pause')}
        checked={paused}
        held={!live || pausing}
        onChange={(value) => void setPaused(value)}
      />
    </Row>
    {#if changed}
      <div class="actions">
        <Button variant="primary" disabled={!valid || saving} onclick={save}>{$t('frameleaf_userpage_save')}</Button>
        <Button disabled={saving} onclick={reset}>{$t('frameleaf_userpage_undo')}</Button>
      </div>
    {/if}
  </Section>

  <Section title={$t('frameleaf_userpage_security')} description={$t('frameleaf_userpage_security_description')}>
    <AccountSecurityPanel {user} {sessions} />
    {#if !user.isAdmin && !user.deletedAt}
      <DesktopMemberApproval userId={user.id} />
    {/if}
  </Section>

  <Section
    title={$t('frameleaf_userpage_turned_on')}
    description={$t('frameleaf_userpage_turned_on_description', { values: { name: user.name } })}
  >
    {#if changing}
      <AccountPreferencesEditor
        {preferences}
        accountName={user.name}
        editable={live}
        save={savePreferences}
        load={loadPreferences}
        {onOpenPrivacy}
        onSaved={onPreferencesSaved}
      />
      <div class="actions">
        <Button onclick={() => (changing = false)}>{$t('frameleaf_userpage_done')}</Button>
      </div>
    {:else}
      <Facts rows={facts} />
      {#if confirming}
        <Notice tone="warn" title={$t('frameleaf_userpage_change_title', { values: { name: user.name } })}>
          {$t('frameleaf_userpage_change_body', { values: { name: user.name } })}
          {#snippet action()}
            <Button
              variant="primary"
              onclick={() => {
                confirming = false;
                changing = true;
              }}
            >
              {$t('frameleaf_userpage_continue')}
            </Button>
            <Button onclick={() => (confirming = false)}>{$t('cancel')}</Button>
          {/snippet}
        </Notice>
      {:else if live}
        <div class="actions">
          <Button onclick={() => (confirming = true)}>{$t('frameleaf_userpage_change_for_them')}</Button>
        </div>
      {/if}
    {/if}
    <Advanced summary={$t('frameleaf_userpage_advanced')}>
      <Row label={$t('frameleaf_userpage_account_id')} help={$t('frameleaf_userpage_account_id_help')}>
        <span class="id"><code>{user.id}</code></span>
        <Button onclick={copyId}>{copied ? $t('frameleaf_userpage_copied') : $t('frameleaf_userpage_copy')}</Button>
      </Row>
      <Row label={$t('frameleaf_userpage_folder')} help={$t('frameleaf_userpage_folder_help')}>
        <Field
          label={$t('frameleaf_userpage_folder')}
          value={storageLabel}
          placeholder={$t('frameleaf_userpage_folder_automatic')}
          disabled={!live}
          onChange={(value) => (storageLabel = value)}
        />
      </Row>
    </Advanced>
  </Section>

  <AccountLifecyclePanel {user} />
</KitPage>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-3);
  }
  .id code {
    font-size: var(--fl-font-small);
    word-break: break-all;
  }
</style>
