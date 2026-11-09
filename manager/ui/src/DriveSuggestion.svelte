<script lang="ts">
  // FL-1321 / FL-1323: the fast drive Manager suggests and why, or plainly why it isn't suggesting one. Shared by the
  // setup Storage step ("Use <drive>") and the Storage page ("Move to <drive>…").
  import Icon from './Icon.svelte';
  import type { Suggestion } from './drives';
  let {
    suggestion,
    applied = false,
    action,
    disabled = false,
    use,
  } = $props<{
    suggestion: Suggestion | null | undefined;
    applied?: boolean;
    /** The button's words, e.g. "Use Cache pool". */
    action: string;
    disabled?: boolean;
    use: () => void;
  }>();
</script>

{#if suggestion?.status === 'found'}
  <div class="st-suggest"><Icon name={applied ? 'check-circle' : 'bulb'} /><div><strong>{suggestion.title}</strong><p>{suggestion.reason}</p></div>{#if !applied}<button type="button" class="button" {disabled} onclick={use}>{action}</button>{/if}</div>
{:else if suggestion}
  <p class="st-suggest-note"><Icon name="info-outline" /><span>{suggestion.reason}</span></p>
{/if}
