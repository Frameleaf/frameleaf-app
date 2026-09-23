<script lang="ts">
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { defaultSpacePersonName, spacePersonCandidates } from '$lib/frameleaf/shared-space';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    linkSharedSpacePerson,
    unlinkSharedSpacePerson,
    type AlbumResponseDto,
    type PersonResponseDto,
    type SharedSpacePersonResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountPlusOutline, mdiAccountRemoveOutline, mdiAccountOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The people a shared space knows about (FL-55).
   *
   * Two lists, deliberately asymmetric, because a `person` belongs to one
   * account: its name, its birth date and its thumbnail are that account's
   * private naming of their own faces, and a space must not hand any of that to
   * the other members.
   *
   * - **In this space** is what members have chosen to publish. Each entry
   *   carries the space's *own* identity for somebody — a name the space uses
   *   and a picture that is already in the space — and nothing borrowed. There
   *   is no person id in the response at all, so linking the same face in two
   *   spaces does not let anybody join them up.
   * - **Seen in this space** is the signed-in person's own people, found on the
   *   space's items. Their library, their names, shown to nobody else. This is
   *   the "people seen in the space" evidence, and it is per member on purpose:
   *   it is the only version of that list that discloses nothing.
   *
   * The name is independent in both directions. Naming somebody here does not
   * rename them in the member's library, and renaming them there does not
   * change what the space calls them.
   *
   * Unlinking removes the link and only the link. The person, their name, their
   * faces and every item that shows them are untouched, and so is the space.
   */
  interface Props {
    space: AlbumResponseDto;
    /** People published into the space. */
    linked: SharedSpacePersonResponseDto[];
    /** The signed-in person's own people seen on the space's items. */
    candidates: PersonResponseDto[];
    onChanged: () => Promise<void> | void;
  }

  let { space, linked, candidates, onChanged }: Props = $props();

  const offered = $derived(spacePersonCandidates(candidates));

  let choice = $state('');
  let busy = $state(false);
  let status = $state('');

  const chosen = $derived(offered.find((person) => person.id === choice));

  // Offering the member's own name is a convenience; the space stores its own copy. Choosing another
  // person offers their name again; typing overrides it.
  let name = $derived(chosen ? defaultSpacePersonName(chosen) : '');

  const link = async () => {
    if (!choice) {
      return;
    }
    busy = true;
    try {
      const label = name.trim() || defaultSpacePersonName(chosen ?? { name: '' });
      await linkSharedSpacePerson({
        id: space.id,
        sharedSpacePersonLinkDto: { personId: choice, ...(name.trim() && { name: name.trim() }) },
      });
      status = $t('frameleaf_spaces_person_linked', { values: { name: label } });
      choice = '';
      await onChanged();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_people'));
    } finally {
      busy = false;
    }
  };

  const unlink = async (person: SharedSpacePersonResponseDto) => {
    busy = true;
    try {
      await unlinkSharedSpacePerson({ id: space.id, linkId: person.id });
      status = $t('frameleaf_spaces_person_unlinked', { values: { name: person.name } });
      await onChanged();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_people'));
    } finally {
      busy = false;
    }
  };

  const coverOf = (person: SharedSpacePersonResponseDto) =>
    person.coverAssetId ? getAssetMediaUrl({ id: person.coverAssetId, size: AssetMediaSize.Thumbnail }) : null;
</script>

<section class="space-people" aria-labelledby="frameleaf-space-people">
  <h2 id="frameleaf-space-people">{$t('frameleaf_spaces_people')}</h2>
  <p class="hint">{$t('frameleaf_spaces_people_hint')}</p>

  {#if linked.length === 0}
    <p class="empty">{$t('frameleaf_spaces_people_empty')}</p>
  {:else}
    <ul class="tiles">
      {#each linked as person (person.id)}
        <li>
          <span class="face" aria-hidden={true}>
            {#if coverOf(person)}
              <img src={coverOf(person)} alt="" loading="lazy" draggable="false" />
            {:else}
              <Icon icon={mdiAccountOutline} size="20" />
            {/if}
          </span>
          <span class="about">
            <span class="name">{person.name || $t('frameleaf_spaces_person_unnamed')}</span>
            <span class="meta">
              {$t('frameleaf_spaces_person_count', { values: { count: person.assetCount } })}
              · {$t('frameleaf_spaces_person_linked_by', { values: { name: person.linkedBy.name } })}
            </span>
          </span>
          {#if person.canUnlink}
            <button
              type="button"
              disabled={busy}
              aria-label={$t('frameleaf_spaces_person_unlink_for', { values: { name: person.name } })}
              onclick={() => unlink(person)}
            >
              <Icon icon={mdiAccountRemoveOutline} size="16" aria-hidden={true} />
              {$t('frameleaf_spaces_person_unlink')}
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <h3>{$t('frameleaf_spaces_people_seen')}</h3>
  <p class="hint">{$t('frameleaf_spaces_people_seen_hint')}</p>

  {#if offered.length === 0}
    <p class="empty">{$t('frameleaf_spaces_people_seen_empty')}</p>
  {:else}
    <div class="controls">
      <label>
        <span>{$t('frameleaf_spaces_person_choose')}</span>
        <select bind:value={choice} disabled={busy}>
          <option value="">{$t('frameleaf_spaces_person_choose')}</option>
          {#each offered as person (person.id)}
            <option value={person.id}>{person.name || $t('frameleaf_spaces_person_unnamed')}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{$t('frameleaf_spaces_person_name')}</span>
        <input type="text" bind:value={name} disabled={busy || !choice} maxlength="255" />
      </label>
      <button type="button" class="primary" disabled={busy || !choice} onclick={link}>
        <Icon icon={mdiAccountPlusOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_person_link')}
      </button>
    </div>
    <p class="hint">{$t('frameleaf_spaces_person_name_hint')}</p>
  {/if}

  <Status message={status} {busy} />
</section>

<style>
  .space-people {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--fl-text);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  h3 {
    margin: 0.75rem 0 0;
    font-size: 0.875rem;
    font-weight: 700;
  }
  .hint,
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .tiles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .tiles li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .face {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex: none;
    overflow: hidden;
    border-radius: 999px;
    background: var(--fl-raised);
  }
  .face img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .about {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: 0.875rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  select,
  input {
    min-height: 36px;
    min-width: 12rem;
    padding: 0 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
  button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  button:disabled {
    opacity: 0.6;
  }
</style>
