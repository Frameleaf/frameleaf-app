<script lang="ts">
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { insertMention, mentionCandidates, mentionQueryAt, splitMentions } from '$lib/frameleaf/shared-space';
  import type { SharedSpaceMemberResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiSend } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The box a shared space comment is written in (FL-55), with @mentions.
   *
   * Typing "@" and some letters opens a list of the space's members; picking one writes the
   * server's `@{userId}` token into the text, never the name, so the mention survives a rename
   * and the server can check it against the current members. Only members who have joined are
   * offered — the server refuses a mention of anyone else — and the author is not offered to
   * themselves. Enter posts, Shift+Enter breaks a line, and while the list is open the arrow
   * keys move through it and Enter or Tab picks.
   */
  interface Props {
    members: SharedSpaceMemberResponseDto[];
    currentUserId?: string;
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    busy?: boolean;
    /** The submit button's text; "Post" by default. */
    submitLabel?: string;
    autofocus?: boolean;
    onSubmit: (text: string) => void | Promise<void>;
    /** When given, a Cancel button and Escape leave the composer. */
    onCancel?: () => void;
  }

  let {
    members,
    currentUserId,
    value = $bindable(''),
    placeholder,
    disabled = false,
    busy = false,
    submitLabel,
    autofocus = false,
    onSubmit,
    onCancel,
  }: Props = $props();

  let textarea = $state<HTMLTextAreaElement>();
  let caret = $state(0);
  let active = $state(0);
  let dismissed = $state(false);
  const listId = `frameleaf-mentions-${Math.random().toString(36).slice(2, 8)}`;

  const query = $derived(dismissed ? null : mentionQueryAt(value, caret));
  const candidates = $derived(query ? mentionCandidates(members, query.query, currentUserId) : []);
  const open = $derived(!!query && candidates.length > 0);

  const syncCaret = () => {
    caret = textarea?.selectionStart ?? value.length;
    active = 0;
    dismissed = false;
  };

  const pick = (userId: string) => {
    if (!query) {
      return;
    }
    const next = insertMention(value, query, caret, userId);
    value = next.text;
    caret = next.caret;
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled || busy) {
      return;
    }
    void onSubmit(text);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (open) {
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          active = (active + 1) % candidates.length;
          return;
        }
        case 'ArrowUp': {
          event.preventDefault();
          active = (active - 1 + candidates.length) % candidates.length;
          return;
        }
        case 'Enter':
        case 'Tab': {
          event.preventDefault();
          pick(candidates[active].user.id);
          return;
        }
        case 'Escape': {
          event.preventDefault();
          event.stopPropagation();
          dismissed = true;
          return;
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape' && onCancel) {
      event.stopPropagation();
      onCancel();
    }
  };

  // Focusing puts the caret after what is already there, so a reply that starts with an @mention
  // carries straight on after it.
  $effect(() => {
    if (!(autofocus && textarea)) {
      return;
    }

    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    caret = end;
  });

  // The box holds `@{id}` tokens; underneath, the text reads as it will be shown, with names.
  const segments = $derived(
    splitMentions(
      value,
      members.map(({ user }) => user),
    ),
  );
  const hasMentions = $derived(segments.some(({ kind }) => kind === 'mention'));
</script>

<div class="composer">
  <textarea
    bind:this={textarea}
    bind:value
    rows="2"
    {placeholder}
    {disabled}
    aria-label={placeholder}
    aria-autocomplete="list"
    aria-controls={open ? listId : undefined}
    oninput={syncCaret}
    onclick={syncCaret}
    onkeyup={syncCaret}
    onkeydown={onKeydown}></textarea>
  {#if open}
    <ul class="mentions" role="listbox" id={listId} aria-label={$t('frameleaf_spaces_comments_mentions')}>
      {#each candidates as candidate, index (candidate.user.id)}
        <li role="option" aria-selected={index === active}>
          <button
            type="button"
            tabindex="-1"
            onmousedown={(event) => event.preventDefault()}
            onclick={() => pick(candidate.user.id)}
          >
            <UserAvatar user={candidate.user} size="sm" noTitle />
            <span class="name">{candidate.user.name}</span>
            <small>{candidate.user.email}</small>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if hasMentions}
    <p class="preview">
      <span class="preview-label">{$t('frameleaf_spaces_comments_preview')}</span>
      {#each segments as segment, index (index)}
        {#if segment.kind === 'mention'}
          <span class="mention">@{segment.user?.name ?? $t('frameleaf_spaces_comments_unknown_member')}</span>
        {:else}
          {segment.text}
        {/if}
      {/each}
    </p>
  {/if}
  <div class="row">
    <small class="hint">{$t('frameleaf_spaces_comments_mention_hint')}</small>
    {#if onCancel}
      <button type="button" onclick={onCancel}>{$t('cancel')}</button>
    {/if}
    <button type="button" class="primary" disabled={disabled || busy || !value.trim()} onclick={submit}>
      <Icon icon={mdiSend} size="16" aria-hidden={true} />
      {submitLabel ?? $t('frameleaf_spaces_comments_send')}
    </button>
  </div>
</div>

<style>
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  textarea {
    inline-size: 100%;
    resize: vertical;
    min-block-size: 3rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
    font-size: 0.875rem;
  }
  textarea:disabled {
    opacity: 0.6;
  }
  .mentions {
    position: absolute;
    inset-block-end: calc(100% - 0.25rem);
    inset-inline-start: 0;
    z-index: 2;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    min-inline-size: 16rem;
    max-inline-size: 100%;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.16);
  }
  .mentions button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    inline-size: 100%;
    padding: 0.375rem 0.5rem;
    border: 0;
    border-radius: calc(var(--fl-radius) - 2px);
    background: transparent;
    color: var(--fl-text);
    font-size: 0.8125rem;
    text-align: start;
  }
  .mentions li[aria-selected='true'] button {
    background: var(--fl-panel);
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .mentions small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .preview {
    margin: 0;
    color: var(--fl-text);
    font-size: 0.8125rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .preview-label {
    margin-inline-end: 0.375rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .mention {
    color: var(--fl-accent);
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .hint {
    margin-inline-end: auto;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .row button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .row button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .row button:disabled {
    opacity: 0.6;
  }
</style>
