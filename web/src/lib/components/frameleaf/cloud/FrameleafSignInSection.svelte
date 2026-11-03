<script lang="ts">
  /**
   * Settings → Who can sign in → Sign in with Frameleaf (FL-158, FL-541 after the prototype's
   * `settings-v2/cloud/FrameleafSignIn.jsx`): who can and who can't, by name, with a Remind email for
   * someone who has not linked. The rule for away from home is a sentence pointing at Remote access,
   * the one place it is set. The client proves itself with this server's key only, so there is no
   * client secret to manage (FL-177).
   *
   * FL-235 (owner decision, 2026-10-01): a person invited through Frameleaf gets their own account
   * here. FL-516: the space such accounts start with is "Space for new people" under Users.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getCloudSignInPeople, remindCloudSignIn, type CloudSignInPeopleResponseDto } from '@frameleaf/sdk';
  import { mdiAccountOutline, mdiCloudAlertOutline, mdiCloudCheckOutline, mdiCloudOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  const linked = $derived(status?.state === 'linked');
  let people = $state<CloudSignInPeopleResponseDto | null>(null);
  let peopleFailed = $state(false);
  let busy = $state(false);
  let failure = $state('');
  let said = $state('');

  const loadPeople = async () => {
    try {
      people = await getCloudSignInPeople();
      peopleFailed = false;
    } catch {
      peopleFailed = true;
    }
  };
  $effect(() => {
    if (linked) {
      void loadPeople();
    }
  });

  const missing = $derived(people?.people.filter((person) => !person.linked) ?? []);
  const total = $derived(people?.people.length ?? 0);
  const me = $derived(authManager.authenticated ? authManager.user.id : undefined);

  const save = async (call: () => Promise<unknown>) => {
    busy = true;
    failure = '';
    try {
      await call();
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const remind = (person: { id: string; name: string }) =>
    save(async () => {
      await remindCloudSignIn({ id: person.id });
      said = $t('frameleaf_signin_reminded', { values: { name: person.name } });
    });

  const setShowOnLocalLogin = (value: boolean) => save(() => cloudManager.setShowOnLocalLogin(value));

  // The button's words, edited here and saved on their own (the login page shows them).
  let buttonText = $derived(status?.signInButtonText ?? '');
  const buttonTextChanged = $derived(
    !!status && buttonText.trim().length > 0 && buttonText.trim() !== status.signInButtonText,
  );
  const saveButtonText = () => save(() => cloudManager.setButtonText(buttonText.trim()));

  const provider = $derived(status?.signInIssuer ? new URL(status.signInIssuer).host : '');
</script>

<div data-section="frameleaf-signin">
  <KitPage>
    <Said message={said} onDismiss={() => (said = '')} />
    {#if !linked}
      <Hero
        label={$t('frameleaf_signin_label')}
        tone="quiet"
        icon={mdiCloudOutline}
        title={$t('frameleaf_signin_hero_off')}
        body={$t('frameleaf_signin_hero_off_body')}
      >
        {#snippet actions()}
          <Button variant="primary" onclick={() => getCloudManager.open('signin')}>{$t('frameleaf_get_cloud')}</Button>
        {/snippet}
      </Hero>
    {:else if people && missing.length > 0}
      <Hero
        label={$t('frameleaf_signin_label')}
        tone="warn"
        icon={mdiCloudAlertOutline}
        title={$t('frameleaf_signin_hero_some', { values: { linked: total - missing.length, total } })}
        body={$t('frameleaf_signin_hero_some_body', {
          values: { names: missing.map((person) => person.name).join(', '), count: missing.length },
        })}
      >
        {#snippet actions()}
          {#if missing.length === 1 && people?.canRemind && missing[0].id !== me}
            <Button variant="primary" disabled={busy} onclick={() => void remind(missing[0])}
              >{$t('frameleaf_signin_remind_one', { values: { name: missing[0].name } })}</Button
            >
          {/if}
        {/snippet}
      </Hero>
    {:else if people}
      <Hero
        label={$t('frameleaf_signin_label')}
        tone="good"
        icon={mdiCloudCheckOutline}
        title={$t('frameleaf_signin_hero_all')}
        body={$t('frameleaf_signin_hero_all_body', { values: { count: total } })}
      />
    {:else if peopleFailed}
      <Hero
        label={$t('frameleaf_signin_label')}
        tone="quiet"
        icon={mdiCloudOutline}
        title={$t('frameleaf_signin_available')}
        body={$t('frameleaf_signin_people_unread')}
      />
    {/if}

    {#if failure}
      <Notice tone="warn" title={failure} />
    {/if}

    {#if linked && people}
      <Section title={$t('frameleaf_signin_who')} description={$t('frameleaf_signin_who_description')}>
        <ItemList>
          {#each people.people as person (person.id)}
            <Item
              icon={mdiAccountOutline}
              off={!person.linked}
              name={person.name}
              detail={person.email}
              tone={person.linked ? 'good' : 'warn'}
              status={person.linked ? $t('frameleaf_signin_linked') : $t('frameleaf_signin_not_yet')}
              note={person.linked ? (person.frameleafEmail ?? undefined) : $t('frameleaf_signin_home_only')}
            >
              {#snippet action()}
                {#if !person.linked && person.id === me}
                  <Button onclick={() => goto(commandCenterUrl('preferences', 'frameleaf-account'))}
                    >{$t('frameleaf_signin_link_yours')}</Button
                  >
                {:else if !person.linked && people?.canRemind}
                  <Button disabled={busy} onclick={() => void remind(person)}>{$t('frameleaf_signin_remind')}</Button>
                {/if}
              {/snippet}
            </Item>
          {/each}
        </ItemList>
        {#if missing.length > 0 && !people.canRemind}
          <p class="hint">{$t('frameleaf_signin_remind_unavailable')}</p>
        {/if}
      </Section>
    {/if}

    <Section title={$t('frameleaf_signin_where')}>
      <p class="said-back">
        {$t('frameleaf_signin_away')}
        <TextLink href={commandCenterUrl('cloud', 'cloud-remote')}>{$t('frameleaf_signin_away_link')}</TextLink>
      </p>
      <Row
        label={$t('frameleaf_signin_offer_home')}
        help={linked ? $t('frameleaf_signin_offer_home_help') : $t('frameleaf_signin_link_first')}
      >
        <Switch
          label={$t('frameleaf_signin_offer_home_switch')}
          checked={linked && !!status?.signInShowOnLocalLogin}
          held={!linked || busy}
          onChange={(value) => void setShowOnLocalLogin(value)}
        />
      </Row>
      <Row label={$t('frameleaf_signin_space')} help={$t('frameleaf_signin_space_help')}>
        <Button onclick={() => goto(commandCenterUrl('users'))}>{$t('frameleaf_signin_open_users')}</Button>
      </Row>
      <Advanced>
        <Row label={$t('frameleaf_signin_words')} help={$t('frameleaf_signin_words_help')}>
          <div class="inline">
            <Field
              label={$t('frameleaf_signin_words')}
              value={buttonText}
              disabled={busy}
              onChange={(value) => (buttonText = value)}
            />
            <Button disabled={busy || !buttonTextChanged} onclick={() => void saveButtonText()}>{$t('save')}</Button>
          </div>
        </Row>
        <Row label={$t('frameleaf_signin_server_id')} help={$t('frameleaf_signin_server_id_help')}>
          <code>{status?.signInClientId ?? status?.instanceId ?? '—'}</code>
        </Row>
        {#if linked && provider}
          <Row label={$t('frameleaf_signin_through')} help={$t('frameleaf_signin_through_help')}>
            <span>{provider}</span>
          </Row>
        {/if}
        <Row label={$t('frameleaf_signin_own_provider')} help={$t('frameleaf_signin_own_provider_help')}>
          <Button onclick={() => goto(commandCenterUrl('security', 'authentication'))}
            >{$t('frameleaf_signin_open_own_provider')}</Button
          >
        </Row>
      </Advanced>
    </Section>
  </KitPage>
</div>

<style>
  .said-back {
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-text);
  }
  .hint {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .inline {
    display: flex;
    gap: var(--fl-space-2);
    align-items: center;
  }
  code {
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
</style>
