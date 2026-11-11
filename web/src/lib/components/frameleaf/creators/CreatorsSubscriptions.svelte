<script lang="ts">
  import { MediaSubscriptionAction, updateMediaSubscription, type MediaCreatorResponseDto } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiPause, mdiPlay } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { MEDIA_INTERVALS, type MediaInterval } from '$lib/components/frameleaf/media/boards-media';
  import { creatorPlatform, creatorsHref, creatorState, creatorStatus, platformName } from '$lib/frameleaf/creators';
  import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
  import CreatorAvatar from './CreatorAvatar.svelte';
  import PlatformMark from './PlatformMark.svelte';

  /** Every subscription in one list (prototype `Manage`). */
  let pending = $state('');
  let failed = $state(false);

  const change = async (
    creator: MediaCreatorResponseDto,
    dto: { action?: MediaSubscriptionAction; intervalMinutes?: MediaInterval },
    message?: string,
  ) => {
    if (pending || !creator.subscription) {
      return;
    }
    pending = creator.id;
    failed = false;
    try {
      await updateMediaSubscription({ id: creator.subscription.id, mediaSubscriptionUpdateDto: dto });
      if (message) {
        toastManager.primary(message);
      }
    } catch {
      failed = true;
    } finally {
      // Read again either way, so a choice that was not saved goes back to what the Library has.
      await creatorsStore.refreshCreator(creator.id);
      pending = '';
    }
  };
</script>

<header class="cr-head">
  <h1>{$t('frameleaf_creators_subscriptions')}</h1>
  <p>{$t('frameleaf_creators_subscriptions_intro')}</p>
</header>
<div class="cr-scroll">
  {#if failed}<InlineError compact message={$t('frameleaf_creators_action_error')} />{/if}
  {#if creatorsStore.following.length === 0}
    <p class="cr-empty">{$t('frameleaf_creators_subscriptions_empty')}</p>
  {:else}
    <table class="cr-manage">
      <thead>
        <tr>
          <th scope="col">{$t('frameleaf_creators_column_creator')}</th>
          <th scope="col">{$t('frameleaf_creators_column_status')}</th>
          <th scope="col">{$t('frameleaf_creators_column_interval')}</th>
          <th scope="col">{$t('frameleaf_creators_column_saved')}</th>
          <th scope="col"><span class="sr-only">{$t('frameleaf_creators_column_actions')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each creatorsStore.following as creator (creator.id)}
          {@const platform = creatorPlatform(creator.provider, creator.url)}
          {@const standing = creatorState(creator)}
          {@const status = creatorStatus(creator, $locale)}
          <tr class={standing}>
            <th scope="row">
              <a href={creatorsHref({ creator: creator.id })}>
                <CreatorAvatar {creator} size={32} />
                <span>
                  <strong>{creator.name}</strong>
                  <small>
                    <PlatformMark {platform} provider={creator.provider} size={12} />
                    {platformName(platform, creator.provider) || $t('frameleaf_creators_platform_website')}
                  </small>
                </span>
              </a>
            </th>
            <td>{$t(status.key, { values: status.values })}</td>
            <td>
              <select
                value={creator.subscription?.intervalMinutes}
                disabled={pending !== ''}
                aria-label={$t('frameleaf_creators_how_often', { values: { name: creator.name } })}
                onchange={(event) =>
                  void change(creator, { intervalMinutes: Number(event.currentTarget.value) as MediaInterval })}
              >
                {#each MEDIA_INTERVALS as value (value)}
                  <option {value}>{$t(`frameleaf_creators_interval_${value}`)}</option>
                {/each}
              </select>
            </td>
            <td>{creator.savedCount}</td>
            <td>
              {#if standing === 'paused'}
                <Button
                  disabled={pending !== ''}
                  onclick={() =>
                    void change(
                      creator,
                      { action: MediaSubscriptionAction.Resume },
                      $t('frameleaf_creators_carrying_on'),
                    )}
                >
                  <Icon icon={mdiPlay} size="18" aria-hidden={true} />{$t('frameleaf_creators_carry_on')}
                </Button>
              {:else}
                <Button
                  disabled={pending !== ''}
                  onclick={() =>
                    void change(creator, { action: MediaSubscriptionAction.Pause }, $t('frameleaf_creators_paused'))}
                >
                  <Icon icon={mdiPause} size="18" aria-hidden={true} />{$t('frameleaf_creators_pause')}
                </Button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
