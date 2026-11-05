<script lang="ts">
  /**
   * Your sign-in & privacy › How you sign in (the approved prototype's `MySignIn` in
   * `settings-v2/cloud/Personal.jsx`): every way into the account in one place. It opens on how many
   * ways work (or, when this server is linked to Frameleaf and the account is not, that signing in
   * away from home needs it), then one list: the email, the password, the Frameleaf account and,
   * where the administrator added one, the sign-in provider. The password and the sign-in provider
   * used to be two pages; both addresses (`password`, `oauth`) open this one.
   *
   * The server does not record when a password last changed, so the password row says whether one
   * is set rather than when (the prototype's "Changed 3 months ago").
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import FrameleafAccountSection from '$lib/components/frameleaf/access/FrameleafAccountSection.svelte';
  import PasswordDialog from '$lib/components/frameleaf/access/PasswordDialog.svelte';
  import SignInProviderSection from '$lib/components/frameleaf/access/SignInProviderSection.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAuthStatus, type AuthStatusResponseDto, type FrameleafAccountLinkResponseDto } from '@frameleaf/sdk';
  import { modalManager } from '@frameleaf/ui';
  import { mdiEmailOutline, mdiFormTextboxPassword, mdiLoginVariant } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { onSessionsChanged }: { onSessionsChanged?: () => void } = $props();

  let auth = $state<AuthStatusResponseDto | null>(null);
  let link = $state<FrameleafAccountLinkResponseDto | null>(null);
  let frameleaf = $state<ReturnType<typeof FrameleafAccountSection>>();

  onMount(() => {
    void getAuthStatus()
      .then((value) => (auth = value))
      .catch(() => {});
  });

  const passwordOn = $derived(featureFlagsManager.value.passwordLogin);
  const providerOn = $derived(featureFlagsManager.value.oauth);
  const hasPassword = $derived(auth ? auth.password : true);

  /** The ways that work for this account today, in the prototype's order. */
  const ways = $derived(
    [
      passwordOn && hasPassword ? $t('frameleaf_how_way_password') : '',
      providerOn && authManager.user.oauthId ? $t('frameleaf_how_way_provider') : '',
      link?.linked ? $t('frameleaf_how_way_frameleaf') : '',
    ].filter(Boolean),
  );
  const either = (items: string[]) => new Intl.ListFormat($locale, { type: 'disjunction' }).format(items);

  const hero = $derived.by(() => {
    if (link && link.available && !link.linked) {
      return {
        tone: 'warn' as const,
        title: $t('frameleaf_how_hero_away'),
        body: $t('frameleaf_how_hero_away_body'),
        link: true,
      };
    }
    return {
      tone: ways.length > 0 ? ('good' as const) : ('quiet' as const),
      title: $t('frameleaf_how_hero_ways', { values: { count: ways.length } }),
      body:
        ways.length === 0
          ? undefined
          : `${$t('frameleaf_how_hero_with', { values: { ways: either(ways) } })} ${
              link?.linked ? $t('frameleaf_how_hero_away_frameleaf') : link ? $t('frameleaf_how_hero_home_only') : ''
            }`.trim(),
      link: false,
    };
  });

  const changePassword = async () => {
    const result = await modalManager.show(PasswordDialog, {});
    if (result?.signedOutOthers) {
      onSessionsChanged?.();
    }
  };
</script>

{#snippet linkMine()}
  <Button variant="primary" onclick={() => void frameleaf?.connect()}>{$t('frameleaf_how_link_mine')}</Button>
{/snippet}

<KitPage>
  <Hero
    tone={hero.tone}
    icon={mdiLoginVariant}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_how_title')}
    actions={hero.link ? linkMine : undefined}
  />

  <Section title={$t('frameleaf_how_ways')}>
    <ItemList>
      <Item
        icon={mdiEmailOutline}
        name={$t('frameleaf_how_email')}
        detail={$t('frameleaf_how_email_detail')}
        tone="good"
        status={authManager.user.email}
      >
        {#snippet action()}
          <Button
            label={$t('frameleaf_how_change_email')}
            onclick={() => goto(commandCenterUrl('preferences', 'account'))}>{$t('frameleaf_how_change')}</Button
          >
        {/snippet}
      </Item>
      <Item
        icon={mdiFormTextboxPassword}
        name={$t('frameleaf_access_password_title')}
        detail={$t('frameleaf_how_password_detail')}
        off={!passwordOn || !hasPassword}
        tone={!passwordOn || !hasPassword ? 'off' : authManager.user.shouldChangePassword ? 'warn' : 'good'}
        status={!passwordOn
          ? $t('frameleaf_how_password_off')
          : !hasPassword
            ? $t('frameleaf_how_password_none')
            : authManager.user.shouldChangePassword
              ? $t('frameleaf_how_password_required')
              : $t('frameleaf_how_password_set')}
        note={!passwordOn
          ? $t('frameleaf_how_password_off_note')
          : authManager.user.shouldChangePassword
            ? $t('frameleaf_access_password_change_required')
            : undefined}
      >
        {#snippet action()}
          {#if passwordOn && hasPassword}
            <Button label={$t('frameleaf_how_change_password')} onclick={changePassword}
              >{$t('frameleaf_how_change')}</Button
            >
          {/if}
        {/snippet}
      </Item>
      <FrameleafAccountSection view="row" bind:link bind:this={frameleaf} />
      {#if providerOn}
        <SignInProviderSection />
      {/if}
    </ItemList>
    <p class="hint">{$t('frameleaf_how_hint')}</p>
  </Section>
</KitPage>

<style>
  .hint {
    margin: 0;
    padding: var(--fl-space-3) 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
</style>
