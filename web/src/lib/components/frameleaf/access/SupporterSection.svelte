<script lang="ts">
  /**
   * Your preferences → Supporter (FL-157): the personal view of Support Frameleaf, built from the same
   * components as the Buy screen (`BuyActivated`, `BuyKeyField`; AuthScreens.jsx:1880-1990).
   *
   * - A personal key (`FL-I…`) is activated for this account through `users/me/license`; the key
   *   travels only in that request body and is shown again only as its last four symbols.
   * - The activated card carries "Hide the supporter badge" (on hides it) and "Remove key" in place.
   * - A server key is an administrator's: it is refused here and activated under Frameleaf Cloud →
   *   Licence, so a personal key is never registered for the server and the reverse.
   */
  import '$lib/frameleaf/auth.css';
  import '$lib/components/frameleaf/buy/buy.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import BuyActivated from '$lib/components/frameleaf/buy/BuyActivated.svelte';
  import BuyKeyField from '$lib/components/frameleaf/buy/BuyKeyField.svelte';
  import { productKeyMessageKey, validateProductKey } from '$lib/frameleaf/cloud';
  import { withoutLockedRuleIds } from '$lib/frameleaf/locked-rules';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { deleteUserLicense, getMyUser, setUserLicense, updateMyPreferences } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  let key = $state('');
  let keyError = $state('');
  let busy = $state(false);
  let notice = $state('');

  const personal = $derived(authManager.user.license ?? null);
  const badgeHidden = $derived(!authManager.preferences.purchase.showSupportBadge);

  const reloadUser = async () => {
    const user = await getMyUser();
    authManager.setUser(user);
    authManager.isPurchased = !!user.license || featureFlagsManager.value.supporter;
  };

  const activate = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const check = validateProductKey(key);
    if (!check.valid) {
      keyError = $t(productKeyMessageKey(check.reason));
      return;
    }
    if (check.kind === 'server') {
      keyError = $t('frameleaf_buy_server_key_elsewhere');
      return;
    }
    busy = true;
    keyError = '';
    try {
      await setUserLicense({ licenseActivateDto: { key: check.key } });
      await reloadUser();
      key = '';
      notice = $t('frameleaf_buy_activated');
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_buy_activation_failed');
    } finally {
      busy = false;
    }
  };

  const remove = async () => {
    busy = true;
    try {
      await deleteUserLicense();
      await reloadUser();
      notice = $t('frameleaf_buy_removed');
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const setBadgeHidden = async (hidden: boolean) => {
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: { purchase: { showSupportBadge: !hidden } },
      });
      authManager.setPreferences(withoutLockedRuleIds(response));
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    }
  };
</script>

<div class="buy-screen supporter-section">
  {#if notice}
    <p class="auth-success" role="status"><span>{notice}</span></p>
  {/if}
  {#if personal}
    <BuyActivated
      name={authManager.user.name}
      kind="individual"
      keyHint={personal.keyHint}
      activatedAt={personal.activatedAt}
      {badgeHidden}
      {busy}
      onBadgeHidden={(hidden) => void setBadgeHidden(hidden)}
      onRemove={() => void remove()}
    />
  {:else}
    <section class="auth-card buy-key fl-continuous-corners" aria-labelledby="supporter-have-key">
      <h3 id="supporter-have-key">{$t('frameleaf_buy_have_key')}</h3>
      <p class="auth-note">{$t('frameleaf_buy_personal_key_help')}</p>
      <form class="buy-key-row" onsubmit={(event) => void activate(event)} novalidate>
        <BuyKeyField bind:value={key} error={keyError} />
        <span class="buy-key-submit">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? $t('frameleaf_buy_activating') : $t('frameleaf_buy_activate')}
          </Button>
        </span>
      </form>
    </section>
  {/if}
  <p class="auth-note">
    <a class="auth-link" href={Route.buy()}>{$t('frameleaf_buy_open')}</a>
    {#if authManager.user.isAdmin}
      · <a class="auth-link" href={commandCenterUrl('cloud', 'cloud-license')}
        >{$t('frameleaf_buy_server_licence_link')}</a
      >
    {/if}
  </p>
</div>

<style>
  /* Not a settings row: it brings the inset a row would have, so the card clears the section edge. */
  .supporter-section {
    gap: 14px;
    padding-block: var(--fl-space-3);
  }
  /*
   * auth.css lays these out only inside a sign-in screen. Without the same stacking here the key's
   * label, field and hint ran together on one line, and the notes and links lost their quiet text.
   */
  .supporter-section :global(h3) {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .supporter-section :global(.auth-field) {
    display: grid;
    gap: var(--fl-space-2);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .supporter-section :global(.auth-field input) {
    width: 100%;
  }
  .supporter-section :global(.auth-field-hint) {
    font-size: var(--fl-font-micro);
    font-weight: 400;
    color: var(--fl-muted);
  }
  .supporter-section :global(.auth-note) {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .supporter-section :global(.auth-link) {
    color: var(--fl-muted);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .supporter-section :global(.auth-link:hover) {
    color: var(--fl-text);
  }
</style>
