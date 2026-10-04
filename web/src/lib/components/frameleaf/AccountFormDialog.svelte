<script lang="ts">
  /**
   * Create and edit an account (FL-76), from the design template's `AccountForm`
   * (`design/frameleaf/template/src/AccountsLibraries.jsx`). One component covers both,
   * because the template's form is the same fields with a different submit target.
   *
   * Everything goes through the existing admin endpoints: `createUserAdmin` and
   * `updateUserAdmin`. The server owns every rule this form only hints at — duplicate email,
   * duplicate storage label, the first account having to be an administrator, and an
   * administrator not changing their own admin status — so a rejection still surfaces as an
   * error toast rather than being silently prevented here.
   *
   * Create-time PIN: `UserAdminCreateDto` has always accepted `pinCode`, but until FL-76
   * `BaseService.createUser` stored it in the clear while `update` hashed it, so the field
   * was unusable. `createUser` now hashes it on the same path as the password and
   * `user-admin.service.spec.ts` covers both secrets, so the field is offered here. It stays
   * optional: an account with no PIN simply has no Locked content until its owner sets one.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { canChangeRole } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleCreateUserAdmin, handleUpdateUserAdmin } from '$lib/services/user-admin.service';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { ByteUnit, convertFromBytes, convertToBytes } from '$lib/utils/byte-units';
  import { getUserAdmin, UserAvatarColor, type UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let {
    user,
    onClose,
  }: {
    /** Omitted to create a new account. */
    user?: UserAdminResponseDto;
    onClose: (created?: UserAdminResponseDto) => void;
  } = $props();

  let open = $state(true);
  let working = $state(false);
  let created = $state<UserAdminResponseDto | undefined>();

  let name = $state(user?.name ?? '');
  let email = $state(user?.email ?? '');
  let isAdmin = $state(user?.isAdmin ?? false);
  let avatarColor = $state<string>(user?.avatarColor ?? '');
  let storageLabel = $state(user?.storageLabel ?? '');
  // `bind:value` on a number input hands back a number, or null once the field is emptied.
  let quota = $state<string | number | null>(
    typeof user?.quotaSizeInBytes === 'number' ? convertFromBytes(user.quotaSizeInBytes, ByteUnit.GiB) : '',
  );
  let shouldChangePassword = $state(user?.shouldChangePassword ?? true);
  let notify = $state(true);
  // Bound to a <select>; compared as a string below.
  let authentication = $state('password');
  let password = $state('');
  let passwordConfirm = $state('');
  let pinCode = $state('');
  /** FL-76: a field this form edits changed elsewhere (another administrator or tab) since it opened. */
  let stale = $state(false);
  /** FL-76: the account could not be re-read before saving, so the save was not attempted. */
  let checkFailed = $state(false);

  const colors = Object.values(UserAvatarColor);
  const editing = $derived(!!user);
  const withPassword = $derived(!editing && authentication === 'password');

  // The DTO takes whole bytes (a safe integer), so a fractional GiB is rounded rather than rejected by
  // the server. The largest quota is capped: a huge value would round to Infinity, and an Infinity
  // must never reach the request, where it would serialize to null and mean "unlimited".
  const maxQuotaBytes = Number.MAX_SAFE_INTEGER;
  const maxQuotaGiB = Math.floor(convertFromBytes(maxQuotaBytes, ByteUnit.GiB));
  const quotaEmpty = $derived(String(quota ?? '').trim() === '');
  const quotaBytesRaw = $derived(quotaEmpty ? null : Math.round(convertToBytes(Number(quota), ByteUnit.GiB)));
  const quotaInvalid = $derived(
    quotaBytesRaw !== null && (!Number.isFinite(quotaBytesRaw) || quotaBytesRaw < 0 || quotaBytesRaw > maxQuotaBytes),
  );
  const quotaSizeInBytes = $derived(quotaInvalid ? null : quotaBytesRaw);
  const quotaOverCapacity = $derived(
    !!quotaSizeInBytes && !!userInteraction.serverInfo && quotaSizeInBytes > userInteraction.serverInfo.diskSizeRaw,
  );
  const passwordMismatch = $derived(withPassword && passwordConfirm.length > 0 && password !== passwordConfirm);
  // A PIN is optional, but a partial one is not a PIN: it is either absent or six digits.
  const pinIncomplete = $derived(!editing && pinCode.length > 0 && pinCode.length !== 6);
  const valid = $derived(
    name.trim().length > 0 &&
      email.trim().length > 0 &&
      !passwordMismatch &&
      !pinIncomplete &&
      !quotaInvalid &&
      (!withPassword || password.length > 0),
  );

  const pinHintId = $props.id();

  $effect(() => {
    if (open) {
      return;
    }

    // Secrets never outlive the dialog.
    password = '';
    passwordConfirm = '';
    pinCode = '';
    onClose(created);
  });

  const editedFieldsChanged = (opened: UserAdminResponseDto, latest: UserAdminResponseDto) =>
    opened.name !== latest.name ||
    opened.email !== latest.email ||
    opened.isAdmin !== latest.isAdmin ||
    (opened.avatarColor ?? null) !== (latest.avatarColor ?? null) ||
    (opened.storageLabel ?? null) !== (latest.storageLabel ?? null) ||
    (opened.quotaSizeInBytes ?? null) !== (latest.quotaSizeInBytes ?? null) ||
    opened.shouldChangePassword !== latest.shouldChangePassword;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid || working || quotaInvalid) {
      return;
    }

    working = true;
    try {
      if (user) {
        // FL-76: an edit is a whole-form update, so a change made meanwhile (a role, a quota, a
        // label) would be overwritten silently; check the account first and say so instead. Only the
        // fields this form edits are compared: `updatedAt` also moves on every upload and usage sync,
        // so an account that is backing up could otherwise never be saved.
        checkFailed = false;
        const latest = await getUserAdmin({ id: user.id }).catch(() => undefined);
        if (!latest) {
          checkFailed = true;
          return;
        }
        if (editedFieldsChanged(user, latest)) {
          stale = true;
          return;
        }
        const success = await handleUpdateUserAdmin(user, {
          name,
          email,
          avatarColor: avatarColor === '' ? null : (avatarColor as UserAvatarColor),
          storageLabel,
          quotaSizeInBytes,
          shouldChangePassword,
          // Only send the role when the server would accept it; it refuses a self change.
          ...(canChangeRole(user, authManager.user.id) && { isAdmin }),
        });
        if (success) {
          open = false;
        }
        return;
      }

      const response = await handleCreateUserAdmin({
        name,
        email,
        password: withPassword ? password : '',
        avatarColor: avatarColor === '' ? null : (avatarColor as UserAvatarColor),
        storageLabel,
        quotaSizeInBytes,
        shouldChangePassword: withPassword ? shouldChangePassword : false,
        notify: featureFlagsManager.value.email ? notify : false,
        isAdmin,
        ...(pinCode.length === 6 && { pinCode }),
      });

      if (response) {
        created = response;
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog
  title={editing ? $t('frameleaf_users_edit_title') : $t('frameleaf_users_create_title')}
  closeLabel={$t('close')}
  bind:open
>
  <form onsubmit={submit}>
    <div class="grid">
      <label>
        <span>{$t('frameleaf_users_field_name')}</span>
        <input required maxlength={160} bind:value={name} disabled={working} />
      </label>
      <label>
        <span>{$t('frameleaf_users_field_email')}</span>
        <input required type="email" maxlength={254} bind:value={email} disabled={working} />
      </label>
      <label>
        <span>{$t('frameleaf_users_field_role')}</span>
        <select
          value={isAdmin ? 'admin' : 'user'}
          disabled={working || (user ? !canChangeRole(user, authManager.user.id) : false)}
          onchange={(event) => (isAdmin = (event.currentTarget as HTMLSelectElement).value === 'admin')}
        >
          <option value="user">{$t('frameleaf_users_role_user')}</option>
          <option value="admin">{$t('frameleaf_users_role_admin')}</option>
        </select>
      </label>
      <label>
        <span>{$t('frameleaf_users_field_avatar_color')}</span>
        <select bind:value={avatarColor} disabled={working}>
          <option value="">{$t('frameleaf_users_avatar_color_automatic')}</option>
          {#each colors as color (color)}
            <option value={color}>{color}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{$t('frameleaf_users_field_quota')}</span>
        <!-- `step="any"`: a fractional GiB (or an existing quota that is not whole GiB) must not block the form. -->
        <input
          type="number"
          min="0"
          max={maxQuotaGiB}
          step="any"
          placeholder={$t('unlimited')}
          bind:value={quota}
          disabled={working}
        />
      </label>
      <label>
        <span>{$t('frameleaf_users_field_storage_label')}</span>
        <input maxlength={80} pattern="[a-zA-Z0-9_-]*" bind:value={storageLabel} disabled={working} />
      </label>

      {#if !editing && featureFlagsManager.value.oauth}
        <label>
          <span>{$t('frameleaf_users_field_authentication')}</span>
          <select bind:value={authentication} disabled={working}>
            <option value="password">{$t('frameleaf_users_authentication_password')}</option>
            <option value="provider">{$t('frameleaf_users_authentication_provider')}</option>
          </select>
        </label>
      {/if}

      {#if withPassword}
        <label>
          <span>{$t('frameleaf_users_field_password')}</span>
          <input type="password" autocomplete="new-password" required bind:value={password} disabled={working} />
        </label>
        <label>
          <span>{$t('frameleaf_users_field_password_confirm')}</span>
          <input type="password" autocomplete="new-password" required bind:value={passwordConfirm} disabled={working} />
        </label>
      {/if}
    </div>

    <p class="hint">{$t('frameleaf_users_field_quota_hint')}</p>
    <p class="hint">{$t('frameleaf_users_field_storage_label_hint')}</p>

    {#if editing && storageLabel !== (user?.storageLabel ?? '')}
      <p class="notice">{$t('frameleaf_users_storage_label_notice')}</p>
    {/if}
    {#if quotaInvalid}
      <p class="error" role="alert">{$t('frameleaf_users_quota_invalid', { values: { max: maxQuotaGiB } })}</p>
    {/if}
    {#if quotaOverCapacity}
      <p class="notice">{$t('frameleaf_users_quota_over_capacity')}</p>
    {/if}
    {#if passwordMismatch}
      <p class="error" role="alert">{$t('frameleaf_users_password_mismatch')}</p>
    {/if}

    {#if !editing}
      <fieldset>
        <legend>{$t('frameleaf_users_create_pin_label')}</legend>
        <p class="hint" id={pinHintId}>{$t('frameleaf_users_create_pin_hint')}</p>
        <PinCells
          bind:value={pinCode}
          label={$t('frameleaf_users_create_pin_label')}
          describedBy={pinHintId}
          error={pinIncomplete}
          disabled={working}
        />
        {#if pinIncomplete}
          <p class="error" role="alert">{$t('frameleaf_users_create_pin_incomplete')}</p>
        {/if}
      </fieldset>
    {/if}

    {#if withPassword || editing}
      <label class="check">
        <input type="checkbox" bind:checked={shouldChangePassword} disabled={working} />
        <span>{$t('frameleaf_users_require_password_change')}</span>
      </label>
    {/if}
    {#if !editing && featureFlagsManager.value.email}
      <label class="check">
        <input type="checkbox" bind:checked={notify} disabled={working} />
        <span>{$t('frameleaf_users_notify')}</span>
      </label>
    {/if}

    {#if stale}
      <p class="stale" role="alert">{$t('frameleaf_users_edit_stale')}</p>
    {/if}
    {#if checkFailed}
      <p class="stale" role="alert">{$t('frameleaf_users_edit_check_failed')}</p>
    {/if}

    <footer>
      <Button type="button" disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={!valid || working || stale}>
        {editing ? $t('frameleaf_users_save') : $t('frameleaf_users_create')}
      </Button>
    </footer>
  </form>
</Dialog>

<style>
  .stale {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-warning);
    border-radius: var(--fl-radius-control);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  form {
    margin-top: 0.75rem;
    min-width: min(32rem, 100%);
  }
  .grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }
  label {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  input,
  select {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    min-width: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .check input {
    min-width: 0;
  }
  fieldset {
    margin: 1rem 0 0;
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  legend {
    padding-inline: 0.375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .hint {
    margin: 0.5rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .notice {
    margin: 0.5rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-warning);
  }
  .error {
    margin: 0.5rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
