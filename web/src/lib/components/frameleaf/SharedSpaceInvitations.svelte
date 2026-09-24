<script lang="ts">
  import Status from '$lib/components/frameleaf/Status.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { pendingInvitations } from '$lib/frameleaf/shared-space';
  import { handleError } from '$lib/utils/handle-error';
  import {
    acceptSharedSpaceInvitation,
    declineSharedSpaceInvitation,
    AlbumUserRole,
    type SharedSpacePreviewResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiCheck,
    mdiClose,
    mdiImageMultipleOutline,
    mdiShieldLockOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Invitations to a shared space, shown as the recipient preview (FL-55).
   *
   * This is everything a recipient is told before they join: who is inviting
   * them, the role they are offered, how many people are already in the space
   * and how many items they would see. It is deliberately not a gallery. The
   * server sends no asset with the preview — no ids and no thumbnails — and its
   * counts leave out media marked sensitive and Locked media, so nothing here
   * can show, or even hint at, a photo the recipient has no access to yet.
   * Accepting is what grants access; declining leaves the space untouched.
   */
  interface Props {
    invitations: SharedSpacePreviewResponseDto[];
    /** Re-fetch after an answer; the route owns the loader. */
    onAnswered: () => Promise<void> | void;
  }

  let { invitations, onAnswered }: Props = $props();

  let busyId = $state('');
  let status = $state('');

  const open = $derived(pendingInvitations(invitations));

  const roleLabel = (role: AlbumUserRole) =>
    role === AlbumUserRole.Viewer ? $t('frameleaf_album_role_viewer') : $t('frameleaf_album_role_editor');

  const answer = async (invitation: SharedSpacePreviewResponseDto, accept: boolean) => {
    busyId = invitation.id;
    try {
      if (accept) {
        await acceptSharedSpaceInvitation({ id: invitation.id });
        status = $t('frameleaf_spaces_invitation_accepted', { values: { name: invitation.albumName } });
      } else {
        await declineSharedSpaceInvitation({ id: invitation.id });
        status = $t('frameleaf_spaces_invitation_declined', { values: { name: invitation.albumName } });
      }
      await onAnswered();
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_invitation'));
    } finally {
      busyId = '';
    }
  };
</script>

{#if open.length > 0}
  <section class="invitations" aria-label={$t('frameleaf_spaces_invitations')}>
    <h2>
      {$t('frameleaf_spaces_invitations')}
      <small>{$t('frameleaf_spaces_invitations_hint')}</small>
    </h2>

    <Status message={status} busy={!!busyId} />

    <ul>
      {#each open as invitation (invitation.id)}
        <li>
          <article aria-label={invitation.albumName}>
            <header>
              <UserAvatar user={invitation.invitedBy ?? invitation.owner} size="md" />
              <div class="who">
                <h3>{invitation.albumName}</h3>
                <p>
                  {$t('frameleaf_spaces_invited_by', {
                    values: { name: (invitation.invitedBy ?? invitation.owner).name },
                  })}
                </p>
              </div>
              <span class="role">{roleLabel(invitation.role)}</span>
            </header>

            {#if invitation.description}
              <p class="description">{invitation.description}</p>
            {/if}

            <dl class="facts">
              <div>
                <dt>
                  <Icon icon={mdiImageMultipleOutline} size="14" aria-hidden={true} />
                  {$t('frameleaf_spaces_items_label')}
                </dt>
                <dd>{invitation.assetCount}</dd>
              </div>
              <div>
                <dt><Icon icon={mdiAccountMultipleOutline} size="14" aria-hidden={true} />{$t('people')}</dt>
                <dd>{invitation.memberCount}</dd>
              </div>
            </dl>

            <p class="safety">
              <Icon icon={mdiShieldLockOutline} size="14" aria-hidden={true} />
              {$t('frameleaf_spaces_preview_safety')}
            </p>

            <footer>
              <button
                type="button"
                class="primary"
                disabled={busyId === invitation.id}
                onclick={() => answer(invitation, true)}
              >
                <Icon icon={mdiCheck} size="16" aria-hidden={true} />
                {$t('frameleaf_spaces_invitation_accept')}
              </button>
              <button type="button" disabled={busyId === invitation.id} onclick={() => answer(invitation, false)}>
                <Icon icon={mdiClose} size="16" aria-hidden={true} />
                {$t('frameleaf_spaces_invitation_decline')}
              </button>
            </footer>
          </article>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .invitations h2 {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.75rem;
    font-size: 1rem;
    font-weight: 600;
  }
  .invitations h2 small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 400;
  }
  ul {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  article {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  h3 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who p {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .role {
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  .description {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .facts {
    display: flex;
    gap: 1.25rem;
    margin: 0;
  }
  .facts div {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  dt {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  dd {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .safety {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  footer {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    min-height: 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
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
