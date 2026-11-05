<script lang="ts">
  /**
   * Your preferences → Supporter (FL-157), as the approved prototype draws it
   * (`settings-v2/server/preferences.jsx` Supporter): the answer first (not a supporter yet, a
   * supporter, or covered by this server's licence), then "Have a key?" or "Your licence", then, for
   * an administrator, "A licence for the whole server".
   *
   * - A personal key (`FL-I…`) is activated for this account through `users/me/license`; the key
   *   travels only in that request body and is shown again only as its last four symbols.
   * - "Your licence" carries "Show the supporter badge" and Remove… with a confirmation in place.
   * - A server key is an administrator's: it is refused here and activated under Frameleaf Cloud →
   *   Licence, so a personal key is never registered for the server and the reverse.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { goto } from '$app/navigation';
  import { locale } from '$lib/stores/preferences.store';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiHeart, mdiHeartOutline, mdiOpenInNew } from '@mdi/js';
  import { productKeyMessageKey, validateProductKey } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { setSupportBadgeVisibility } from '$lib/utils/purchase-utils';
  import { deleteUserLicense, getLicenseProducts, getMyUser, setUserLicense } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let key = $state('');
  let keyError = $state('');
  let busy = $state(false);
  let notice = $state('');

  const personal = $derived(authManager.user.license ?? null);
  // FL-544: Support Frameleaf folded into Your Frameleaf Cloud; a member buys their own licence in the store
  let individualStoreUrl = $state<string | null>(null);
  onMount(() => {
    const load = async () => {
      try {
        const products = await getLicenseProducts();
        individualStoreUrl = products.products.find((p) => p.id === 'supporter-individual')?.storeUrl ?? null;
      } catch {
        individualStoreUrl = null;
      }
    };
    void load();
  });
  const badgeShown = $derived(authManager.preferences.purchase.showSupportBadge);
  const serverCovered = $derived(featureFlagsManager.value.supporter);
  let confirmRemove = $state(false);
  const activatedOn = $derived(
    personal?.activatedAt
      ? new Date(personal.activatedAt).toLocaleDateString($locale, { day: 'numeric', month: 'long', year: 'numeric' })
      : '',
  );
  const hero = $derived(
    personal
      ? {
          tone: 'good' as const,
          icon: mdiHeart,
          title: $t('frameleaf_prefs_supporter_hero_mine'),
          body: activatedOn
            ? `${$t('frameleaf_prefs_supporter_activated_on', { values: { date: activatedOn } })} ${$t('frameleaf_prefs_supporter_status_mine')}`
            : $t('frameleaf_prefs_supporter_status_mine_plain'),
        }
      : serverCovered
        ? {
            tone: 'good' as const,
            icon: mdiHeart,
            title: $t('frameleaf_prefs_supporter_hero_server'),
            body: $t('frameleaf_prefs_supporter_status_server'),
          }
        : {
            tone: 'quiet' as const,
            icon: mdiHeartOutline,
            title: $t('frameleaf_prefs_supporter_hero_none'),
            body: $t('frameleaf_prefs_supporter_status_none'),
          },
  );

  const reloadUser = async () => {
    const isCurrent = authManager.captureSession();
    const user = await getMyUser();
    if (!isCurrent()) {
      return;
    }
    authManager.setUser(user);
    authManager.isPurchased = !!user.license || featureFlagsManager.value.supporter;
  };

  const activate = async (event: SubmitEvent) => {
    confirmRemove = false;
    const isCurrent = authManager.captureSession();
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
      if (!isCurrent()) {
        return;
      }
      await reloadUser();
      if (!isCurrent()) {
        return;
      }
      key = '';
      notice = $t('frameleaf_buy_activated');
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_buy_activation_failed');
    } finally {
      busy = false;
    }
  };

  const remove = async () => {
    const isCurrent = authManager.captureSession();
    busy = true;
    try {
      await deleteUserLicense();
      if (!isCurrent()) {
        return;
      }
      await reloadUser();
      if (!isCurrent()) {
        return;
      }
      notice = $t('frameleaf_buy_removed');
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const setBadgeShown = async (shown: boolean) => {
    try {
      await setSupportBadgeVisibility(shown);
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    }
  };
</script>

<KitPage>
  <Said message={notice} onDismiss={() => (notice = '')} />
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_prefs_supporter_status_label')}
    actions={!personal && !serverCovered && individualStoreUrl ? learnMore : undefined}
  />

  {#if personal}
    <Section title={$t('frameleaf_prefs_supporter_yours')}>
      <Row label={$t('frameleaf_prefs_supporter_badge')} help={$t('frameleaf_prefs_supporter_badge_help')}>
        <Switch
          label={$t('frameleaf_prefs_supporter_badge')}
          checked={badgeShown}
          onChange={(shown) => void setBadgeShown(shown)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_supporter_key')} help={$t('frameleaf_prefs_supporter_key_kept')}>
        <div class="inline">
          {#if confirmRemove}
            <span class="value">{$t('frameleaf_buy_remove_personal_prompt')}</span>
            <Button onclick={() => (confirmRemove = false)}>{$t('frameleaf_buy_keep')}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onclick={() => {
                confirmRemove = false;
                void remove();
              }}>{$t('frameleaf_buy_remove_confirm')}</Button
            >
          {:else}
            <span class="value">FL-I•••-••••-{personal.keyHint}</span>
            <Button disabled={busy} onclick={() => (confirmRemove = true)}
              >{$t('frameleaf_prefs_supporter_remove')}</Button
            >
          {/if}
        </div>
      </Row>
      {#if keyError}
        <p class="error" role="alert">{keyError}</p>
      {/if}
    </Section>
  {:else}
    <Section
      title={$t('frameleaf_prefs_supporter_have_key')}
      description={$t('frameleaf_prefs_supporter_have_key_help')}
    >
      <Row label={$t('frameleaf_prefs_supporter_key')} help={$t('frameleaf_prefs_supporter_key_checked')}>
        <form class="inline" onsubmit={(event) => void activate(event)} novalidate>
          <Field
            label={$t('frameleaf_prefs_supporter_key')}
            value={key}
            placeholder="FL-I…"
            invalid={!!keyError}
            describedBy={keyError ? 'supporter-key-error' : undefined}
            onChange={(value) => {
              key = value;
              keyError = '';
            }}
          />
          <Button variant="primary" type="submit" disabled={busy || !key.trim()}>
            {busy ? $t('frameleaf_buy_activating') : $t('frameleaf_buy_activate')}
          </Button>
        </form>
      </Row>
      {#if keyError}
        <p id="supporter-key-error" class="error" role="alert">{keyError}</p>
      {/if}
    </Section>
  {/if}

  {#if authManager.user.isAdmin}
    <Section
      title={$t('frameleaf_prefs_supporter_server_title')}
      description={$t('frameleaf_prefs_supporter_server_help')}
    >
      {#snippet action()}
        <Button onclick={() => void goto(commandCenterUrl('cloud', 'cloud-plan'))}>
          {$t('frameleaf_buy_server_licence_link')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
        </Button>
      {/snippet}
    </Section>
  {/if}
</KitPage>

{#snippet learnMore()}
  <Button onclick={() => individualStoreUrl && window.open(individualStoreUrl, '_blank', 'noopener,noreferrer')}>
    <Icon icon={mdiOpenInNew} size="1.125rem" aria-hidden />
    {$t('frameleaf_prefs_supporter_learn')}
  </Button>
{/snippet}

<style>
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .value {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .error {
    margin: 0;
    padding: 0 0 var(--fl-space-4);
    color: var(--fl-danger);
    font-size: var(--fl-font-callout);
  }
</style>
