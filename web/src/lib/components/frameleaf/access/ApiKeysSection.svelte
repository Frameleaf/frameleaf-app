<script lang="ts">
  /**
   * API keys, from the `api-keys` section of the design template's `PersonalAccess`: Create API
   * key, and for each key its name, what it is for, when it was last used (FL-367) and when it was
   * made, with Edit, Replace and Delete.
   * Creating or rotating shows the new value once; rotating stops the old value at once.
   *
   * FL-655: the access Save to Frameleaf added by signing in (`signedInFrom`) is listed with the other
   * keys as "Added by signing in", with Manage only: it has no value to copy or replace.
   *
   * Drawn as the approved prototype's `ApiKeys` (`settings-v2/cloud/ApiKeys.jsx`): a hero saying how
   * many apps or devices can reach the library (or the never-used key that can do everything), then
   * "Your keys" with New key, each row with Manage › for edit, replace and delete.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import ApiKeyDialog from '$lib/components/frameleaf/access/ApiKeyDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { keyPermissions, keyPurpose, summarizePermissions } from '$lib/frameleaf/personal-access';
  import { handleDeleteApiKey, handleRotateApiKey } from '$lib/services/api-key.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getApiKeys, Permission, type ApiKeyResponseDto } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import { DateTime } from 'luxon';
  import { t, type Translations } from 'svelte-i18n';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import {
    mdiAllInclusive,
    mdiChevronRight,
    mdiImageFrame,
    mdiKeyOutline,
    mdiPlus,
    mdiPuzzleOutline,
    mdiSwapHorizontal,
    mdiTrayArrowUp,
  } from '@mdi/js';

  let { keys = $bindable([]) }: { keys?: ApiKeyResponseDto[] } = $props();

  const refresh = async () => {
    try {
      keys = await getApiKeys();
    } catch {
      // The list keeps what it showed; the next action reports a real problem.
    }
  };

  const made = (key: ApiKeyResponseDto) =>
    DateTime.fromISO(key.createdAt, { locale: $locale }).toLocaleString(DateTime.DATE_MED);
  /** FL-367: "Last used 2 days ago" or "Never used", from what the server records. */
  const lastUsed = (key: ApiKeyResponseDto) =>
    key.lastUsedAt
      ? $t('frameleaf_access_key_last_used', {
          values: { when: DateTime.fromISO(key.lastUsedAt).toRelative({ locale: $locale }) ?? '' },
        })
      : $t('frameleaf_access_key_never_used');

  const permissionText = (key: ApiKeyResponseDto) => {
    const permissions = keyPermissions(key);
    if (permissions.includes(Permission.All)) {
      return $t('frameleaf_access_key_purpose_everything_row');
    }
    const purpose = keyPurpose(permissions);
    if (purpose !== 'custom') {
      return $t(`frameleaf_access_key_purpose_${purpose.replace('-', '_')}_row` as Translations);
    }
    const { shown, more } = summarizePermissions(permissions);
    const list = shown.join(' · ');
    return more > 0 ? $t('frameleaf_access_key_permissions_more', { values: { list, count: more } }) : list;
  };

  /** FL-655: the Manage dialog of an access added by signing in, loaded when it is opened. */
  const manage = async (key: ApiKeyResponseDto) => {
    const { default: ExtensionAccessDialog } =
      await import('$lib/components/frameleaf/access/ExtensionAccessDialog.svelte');
    await modalManager.show(ExtensionAccessDialog, { apiKey: key });
  };

  /** Manage › (`ApiKeys.jsx`): edit the key, or replace or delete it from the same dialog. */
  const open = async (key: ApiKeyResponseDto) => {
    if (key.signedInFrom) {
      await manage(key);
      return;
    }
    const next = await modalManager.show(ApiKeyDialog, { apiKey: key });
    if (next === 'replace') {
      await rotate(key);
    } else if (next === 'delete') {
      await handleDeleteApiKey(key);
    }
  };

  const create = () => modalManager.show(ApiKeyDialog, {});

  const WEEK_MS = 7 * 86_400_000;
  /**
   * A key that can do everything and has never been used, made more than a week ago: the one thing
   * the prototype's hero asks to look at.
   */
  const unused = $derived(
    keys.find(
      (key) =>
        !key.lastUsedAt &&
        !key.signedInFrom &&
        keyPermissions(key).includes(Permission.All) &&
        Date.now() - Date.parse(key.createdAt) > WEEK_MS,
    ),
  );

  const PURPOSE_ICONS: Record<string, string> = {
    view: mdiImageFrame,
    upload: mdiTrayArrowUp,
    'view-upload': mdiSwapHorizontal,
    capture: mdiPuzzleOutline,
    everything: mdiAllInclusive,
  };
  const keyIcon = (key: ApiKeyResponseDto) => {
    const permissions = keyPermissions(key);
    return permissions.includes(Permission.All)
      ? mdiAllInclusive
      : (PURPOSE_ICONS[keyPurpose(permissions)] ?? mdiKeyOutline);
  };

  const rotate = async (key: ApiKeyResponseDto) => {
    const response = await handleRotateApiKey(key);
    if (response) {
      await modalManager.show(ApiKeyDialog, { secret: response.secret });
    }
  };
</script>

<OnEvents
  onApiKeyCreate={() => void refresh()}
  onApiKeyUpdate={(update) => (keys = keys.map((key) => (key.id === update.id ? update : key)))}
  onApiKeyDelete={({ id }) => (keys = keys.filter((key) => key.id !== id))}
/>

{#snippet newKey(primary: boolean)}
  <Button variant={primary ? 'primary' : 'default'} onclick={create}
    ><Icon icon={mdiPlus} size="1.1em" aria-hidden />{$t('frameleaf_access_keys_new')}</Button
  >
{/snippet}
{#snippet newKeyPrimary()}{@render newKey(true)}{/snippet}
{#snippet newKeyQuiet()}{@render newKey(false)}{/snippet}
{#snippet reviewUnused()}
  <Button variant="primary" onclick={() => unused && open(unused)}>{$t('frameleaf_access_keys_review')}</Button>
{/snippet}

<KitPage>
  {#if keys.length === 0}
    <Hero
      tone="quiet"
      icon={mdiKeyOutline}
      title={$t('frameleaf_access_keys_hero_empty')}
      body={$t('frameleaf_access_keys_hero_empty_body')}
      label={$t('frameleaf_access_keys_title')}
      actions={newKeyPrimary}
    />
  {:else if unused}
    <Hero
      tone="warn"
      icon={mdiKeyOutline}
      title={$t('frameleaf_access_keys_hero_unused')}
      body={$t('frameleaf_access_keys_hero_unused_body', { values: { name: unused.name, date: made(unused) } })}
      label={$t('frameleaf_access_keys_title')}
      actions={reviewUnused}
    />
  {:else}
    <Hero
      tone="good"
      icon={mdiKeyOutline}
      title={$t('frameleaf_access_keys_hero_count', { values: { count: keys.length } })}
      body={$t('frameleaf_access_keys_hero_count_body')}
      label={$t('frameleaf_access_keys_title')}
    />
  {/if}

  {#if keys.length > 0}
    <Section
      title={$t('frameleaf_access_keys_yours')}
      description={$t('frameleaf_access_keys_yours_description')}
      action={newKeyQuiet}
    >
      <ItemList>
        {#each keys as key (key.id)}
          <Item
            icon={keyIcon(key)}
            name={key.name}
            detail={permissionText(key)}
            tone={key.lastUsedAt ? 'good' : 'warn'}
            status={lastUsed(key)}
            note={key.signedInFrom
              ? $t('frameleaf_access_key_added_by_sign_in', { values: { date: made(key) } })
              : $t('frameleaf_access_key_made_on', { values: { date: made(key) } })}
          >
            {#snippet action()}
              <Button label={`${$t('frameleaf_access_key_manage')} ${key.name}`} onclick={() => open(key)}
                >{$t('frameleaf_access_key_manage')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
              >
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>
  {/if}
</KitPage>
