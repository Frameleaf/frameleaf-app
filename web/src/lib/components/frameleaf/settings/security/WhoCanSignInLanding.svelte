<script lang="ts">
  /**
   * Your server › Who can sign in (FL-367, the approved prototype's `settings-v2/cloud/SecurityLanding.jsx`):
   * what an administrator sets for everyone. It opens on the answer for the household (everyone can
   * sign in at home and away, or at home only while the server is not linked), then the sign-in
   * methods, Sign in with Frameleaf and the rule for signing in away from home, each with its state,
   * and who has an account. A person's own password, PIN and devices are on "Your sign-in & privacy".
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { signInMethodsState } from '$lib/components/frameleaf/settings/security/sign-in';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { searchUsersAdmin } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiChevronRight,
    mdiEarth,
    mdiHomeOutline,
    mdiKeyOutline,
    mdiShieldAccountOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());
  let people = $state<number | null>(null);
  onMount(() => {
    void searchUsersAdmin({ withDeleted: false })
      .then((users) => (people = users.length))
      .catch(() => (people = null));
  });

  const saved = $derived(getSystemConfigDraft()?.baseline);
  const status = $derived(cloudManager.status);
  const linked = $derived(status?.state === 'linked');
  const linkedPeople = $derived(status?.signInLinkedAccounts ?? 0);
  const methods = $derived(
    signInMethodsState({
      password: saved?.passwordLogin.enabled ?? true,
      provider: saved?.oauth.enabled ?? false,
      frameleaf: linked,
    }),
  );

  const hero = $derived(
    linked
      ? people !== null && linkedPeople < people
        ? {
            tone: 'warn' as const,
            icon: mdiHomeOutline,
            title: $t('frameleaf_security_who_some_home', { values: { count: people - linkedPeople } }),
            body: $t('frameleaf_security_who_some_home_body'),
          }
        : {
            tone: 'good' as const,
            icon: mdiShieldCheckOutline,
            title: $t('frameleaf_security_who_everyone'),
            body: $t('frameleaf_security_who_everyone_body'),
          }
      : {
          tone: 'warn' as const,
          icon: mdiHomeOutline,
          title: $t('frameleaf_security_who_home_only'),
          body: $t('frameleaf_security_who_home_only_body'),
        },
  );

  type Row = { icon: string; name: string; detail: string; status: string; tone: KitTone; href: string };
  const rows = $derived<Row[]>([
    {
      icon: mdiKeyOutline,
      name: $t('frameleaf_security_who_methods'),
      detail: $t('frameleaf_security_who_methods_detail'),
      status: $t(`frameleaf_security_methods_${methods}`),
      tone: methods === 'none' ? 'bad' : 'good',
      href: commandCenterUrl('security', 'authentication'),
    },
    {
      icon: mdiShieldAccountOutline,
      name: $t('frameleaf_security_who_frameleaf'),
      detail: $t('frameleaf_security_who_frameleaf_detail'),
      status: linked
        ? people === null
          ? $t('frameleaf_security_who_frameleaf_linked', { values: { count: linkedPeople } })
          : $t('frameleaf_security_who_frameleaf_of', { values: { count: linkedPeople, people } })
        : $t('frameleaf_security_who_frameleaf_not_linked'),
      tone: linked ? (people !== null && linkedPeople < people ? 'warn' : 'good') : 'off',
      href: commandCenterUrl('security', 'frameleaf-signin'),
    },
    {
      icon: mdiEarth,
      name: $t('frameleaf_security_who_away'),
      detail: $t('frameleaf_security_who_away_detail'),
      status: linked ? $t('frameleaf_security_who_away_frameleaf') : $t('frameleaf_security_who_away_off'),
      tone: linked ? 'good' : 'off',
      href: commandCenterUrl('cloud', 'cloud-remote'),
    },
  ]);
  const peopleRow = $derived<Row>({
    icon: mdiAccountMultipleOutline,
    name: $t('frameleaf_security_who_people'),
    detail: $t('frameleaf_security_who_people_detail'),
    status:
      people === null
        ? $t('frameleaf_security_who_people_body')
        : $t('frameleaf_security_who_people_count', { values: { count: people } }),
    tone: people === null ? 'off' : 'good',
    href: commandCenterUrl('users'),
  });
</script>

{#snippet linkServer()}
  <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
    >{$t('frameleaf_cloud_landing_link_server')}</Button
  >
{/snippet}

{#snippet item(row: Row)}
  <Item
    icon={row.icon}
    off={row.tone === 'off'}
    name={row.name}
    detail={row.detail}
    tone={row.tone}
    status={row.status}
  >
    {#snippet action()}
      <Button label={`${$t('frameleaf_security_who_open')}: ${row.name}`} onclick={() => goto(row.href)}
        >{$t('frameleaf_security_who_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
      >
    {/snippet}
  </Item>
{/snippet}

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_security_who_status')}
    actions={linked ? undefined : linkServer}
  />

  <Section title={$t('frameleaf_security_who_ways')} description={$t('frameleaf_security_who_ways_description')}>
    <ItemList>
      {#each rows as row (row.name)}
        {@render item(row)}
      {/each}
    </ItemList>
  </Section>

  <Section title={$t('frameleaf_security_who_accounts')}>
    <ItemList>
      {@render item(peopleRow)}
    </ItemList>
    <p class="hint">
      {$t('frameleaf_security_who_yours_elsewhere')}
      <TextLink href={commandCenterUrl('privacy')}>{$t('frameleaf_settings_area_privacy')}</TextLink>
    </p>
  </Section>
</KitPage>

<style>
  .hint {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
</style>
