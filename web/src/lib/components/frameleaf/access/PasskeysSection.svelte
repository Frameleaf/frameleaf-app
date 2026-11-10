<script lang="ts">
  /**
   * FL-859: Your sign-in & privacy › Passkeys (the approved FL-767 prototype, `settings-v2/cloud/Passkeys.jsx`):
   * sign in with your face, fingerprint or phone instead of typing the password. It opens on what is
   * true now (some passkeys, none yet, loading, couldn't load, opened on http, a browser that can't make
   * them), lists the passkeys with where each is saved, when it was added and last used, and adds,
   * renames and removes them. Adding asks for the password if it wasn't checked in the last 10 minutes.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PasskeyAddDialog from '$lib/components/frameleaf/access/PasskeyAddDialog.svelte';
  import PasskeyRemoveDialog from '$lib/components/frameleaf/access/PasskeyRemoveDialog.svelte';
  import PasskeyRenameDialog from '$lib/components/frameleaf/access/PasskeyRenameDialog.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { passkeysInThisBrowser } from '$lib/frameleaf/passkeys';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getPasskeys, type PasskeyResponseDto } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import {
    mdiCloudAlertOutline,
    mdiFingerprint,
    mdiKeyPlus,
    mdiKeyVariant,
    mdiLockAlertOutline,
    mdiOpenInNew,
    mdiPencilOutline,
    mdiShieldCheckOutline,
    mdiTrashCanOutline,
    mdiWeb,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './passkeys.css';

  let passkeys = $state<PasskeyResponseDto[] | null>(null);
  let failed = $state(false);
  let said = $state('');
  let fresh = $state<string | null>(null);
  /** The last passkey was just removed here (the prototype's "You don’t have a passkey any more"). */
  let removedAll = $state(false);

  const here = passkeysInThisBrowser();
  const canAdd = here.ok;

  const load = async () => {
    failed = false;
    try {
      passkeys = await getPasskeys();
    } catch {
      failed = true;
    }
  };
  onMount(() => void load());

  /** Where the passkeys were made, which is where they work. */
  const addresses = $derived([...new Set((passkeys ?? []).map(({ rpId }) => rpId))]);
  /** The server's https address, for the note on a plain http page. */
  const secureUrl = $derived.by(() => {
    try {
      const url = new URL(serverConfigManager.value.externalDomain);
      return url.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  });

  const date = (value: string, withTime = false) =>
    new Intl.DateTimeFormat(
      $locale,
      withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
    ).format(new Date(value));

  /** Where a passkey is saved, as the list says it. */
  const savedIn = (passkey: PasskeyResponseDto) =>
    passkey.provider
      ? $t(passkey.backedUp ? 'frameleaf_passkey_saved_synced' : 'frameleaf_passkey_saved_device', {
          values: { provider: passkey.provider },
        })
      : $t(passkey.backedUp ? 'frameleaf_passkey_saved_manager' : 'frameleaf_passkey_saved_key');

  const hero = $derived.by(() => {
    if (failed) {
      return {
        tone: 'warn' as const,
        icon: mdiCloudAlertOutline,
        title: $t('frameleaf_passkey_hero_error'),
        body: $t('frameleaf_passkey_hero_error_body'),
        retry: true,
      };
    }
    if (!passkeys) {
      return { tone: 'quiet' as const, icon: mdiFingerprint, title: $t('frameleaf_passkey_hero_loading') };
    }
    if (!here.ok && here.reason === 'http') {
      return {
        tone: 'warn' as const,
        icon: mdiLockAlertOutline,
        title: $t('frameleaf_passkey_hero_http'),
        body: $t('frameleaf_passkey_hero_http_body', { values: { address: location.origin } }),
        open: !!secureUrl,
      };
    }
    if (!here.ok) {
      return {
        tone: 'warn' as const,
        icon: mdiWeb,
        title: $t('frameleaf_passkey_hero_unsupported'),
        body: $t('frameleaf_passkey_hero_unsupported_body'),
      };
    }
    if (passkeys.length === 0) {
      return {
        tone: 'quiet' as const,
        icon: mdiFingerprint,
        title: removedAll ? $t('frameleaf_passkey_hero_none_now') : $t('frameleaf_passkey_hero_none'),
        body: removedAll ? $t('frameleaf_passkey_hero_none_now_body') : $t('frameleaf_passkey_hero_none_body'),
        add: true,
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_passkey_hero_some', { values: { count: passkeys.length } }),
      body: $t('frameleaf_passkey_hero_some_body'),
    };
  });

  const add = async () => {
    const added = await modalManager.show(PasskeyAddDialog, {});
    if (added) {
      fresh = added.id;
      removedAll = false;
      said = $t('frameleaf_passkey_added', { values: { name: added.name } });
      await load();
    }
  };

  const rename = async (passkey: PasskeyResponseDto) => {
    const renamed = await modalManager.show(PasskeyRenameDialog, { passkey });
    if (renamed) {
      said = $t('frameleaf_passkey_renamed', { values: { name: renamed.name } });
      passkeys = (passkeys ?? []).map((item) => (item.id === renamed.id ? renamed : item));
    }
  };

  const remove = async (passkey: PasskeyResponseDto) => {
    const last = (passkeys ?? []).length === 1;
    const removed = await modalManager.show(PasskeyRemoveDialog, { passkey, last });
    if (removed) {
      said = $t(last ? 'frameleaf_passkey_removed_last' : 'frameleaf_passkey_removed', {
        values: { name: passkey.name },
      });
      passkeys = (passkeys ?? []).filter((item) => item.id !== passkey.id);
      removedAll = passkeys.length === 0;
    }
  };

  const openSecure = () => {
    if (secureUrl) {
      location.assign(new URL(location.pathname + location.search, secureUrl).href);
    }
  };
</script>

{#snippet addButton()}
  <Button variant="primary" disabled={!canAdd} onclick={() => void add()}
    ><Icon icon={mdiKeyPlus} size="1.1em" aria-hidden />{$t('frameleaf_passkey_add')}</Button
  >
{/snippet}
{#snippet heroActions()}
  {#if hero.retry}
    <Button onclick={() => void load()}>{$t('frameleaf_passkey_try_again')}</Button>
  {:else if hero.open && secureUrl}
    <Button variant="primary" onclick={openSecure}
      ><Icon icon={mdiOpenInNew} size="1.1em" aria-hidden />{$t('frameleaf_passkey_open_secure', {
        values: { address: secureUrl.origin },
      })}</Button
    >
  {:else if hero.add}
    {@render addButton()}
  {/if}
{/snippet}

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_passkey_title')}
    actions={hero.retry || hero.open || hero.add ? heroActions : undefined}
  />

  {#if !passkeys && !failed}
    <Section title={$t('frameleaf_passkey_yours')}>
      <ul class="pk-loading" aria-busy="true" aria-label={$t('frameleaf_passkey_loading')}>
        {#each [0, 1, 2] as row (row)}
          <li><span></span><span></span><span></span></li>
        {/each}
      </ul>
    </Section>
  {/if}

  {#if passkeys && passkeys.length > 0}
    <Section
      title={$t('frameleaf_passkey_yours')}
      description={$t('frameleaf_passkey_yours_description', { values: { address: addresses.join(', ') } })}
      action={canAdd ? addButton : undefined}
    >
      <ItemList>
        {#each passkeys as passkey (passkey.id)}
          <Item
            icon={mdiKeyVariant}
            name={passkey.name}
            detail={savedIn(passkey)}
            tone={passkey.lastUsedAt ? 'good' : 'off'}
            status={passkey.id === fresh
              ? $t('frameleaf_passkey_new')
              : passkey.lastUsedAt
                ? $t('frameleaf_passkey_used', { values: { when: date(passkey.lastUsedAt, true) } })
                : $t('frameleaf_passkey_not_used')}
            note={$t('frameleaf_passkey_added_on', { values: { when: date(passkey.createdAt) } })}
          >
            {#snippet action()}
              <div class="pk-row-buttons">
                <Button
                  label={$t('frameleaf_passkey_rename_label', { values: { name: passkey.name } })}
                  onclick={() => void rename(passkey)}
                  ><Icon icon={mdiPencilOutline} size="1.1em" aria-hidden />{$t('frameleaf_passkey_rename')}</Button
                >
                <Button
                  label={$t('frameleaf_passkey_remove_label', { values: { name: passkey.name } })}
                  onclick={() => void remove(passkey)}
                  ><Icon icon={mdiTrashCanOutline} size="1.1em" aria-hidden />{$t('frameleaf_passkey_remove')}</Button
                >
              </div>
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>
  {/if}

  {#if passkeys && passkeys.length === 0}
    <Section title={$t('frameleaf_passkey_how_title')} description={$t('frameleaf_passkey_how_description')}>
      <Points
        rows={[
          { text: $t('frameleaf_passkey_how_password') },
          { text: $t('frameleaf_passkey_how_browser') },
          { text: $t('frameleaf_passkey_how_confirm') },
          { text: $t('frameleaf_passkey_how_name') },
        ]}
      />
    </Section>
  {/if}

  <Section title={$t('frameleaf_passkey_about_title')}>
    <Points
      rows={[
        { text: $t('frameleaf_passkey_about_another_way') },
        { text: $t('frameleaf_passkey_about_two_step') },
        { text: $t('frameleaf_passkey_about_https') },
        { text: $t('frameleaf_passkey_about_address') },
        { text: $t('frameleaf_passkey_about_private') },
        { text: $t('frameleaf_passkey_about_lost') },
      ]}
    />
    <Advanced>
      <p class="pk-quiet pk-advanced">{$t('frameleaf_passkey_advanced')}</p>
    </Advanced>
  </Section>
</KitPage>

<style>
  .pk-advanced {
    max-width: 720px;
    padding-top: var(--fl-space-2);
  }
</style>
