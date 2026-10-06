<script lang="ts">
  import Icon from '../Icon/Icon.svelte';
  import Link from '../Link/Link.svelte';
  import type { GithubLinkProps } from '../../types.js';
  import { asGithubLink } from '../../utilities/common.js';
  import { siGithub } from 'simple-icons';

  const { org, repo, number, type, size = 'medium', icon = true, ...rest }: GithubLinkProps = $props();
  const { href, text } = $derived(asGithubLink({ org, repo, number, type }));

  const resolvedSize = $derived.by(() => {
    switch (size) {
      case 'tiny': {
        return '7px';
      }
      case 'small': {
        return '8px';
      }
      case 'medium': {
        return '10px';
      }
      case 'large': {
        return '12px';
      }
      case 'giant': {
        return '14px';
      }
      default: {
        return size;
      }
    }
  });
</script>

<Link {...rest} {href} class="inline-flex items-center">
  {#if icon}
    <Icon icon={siGithub} size={resolvedSize} class="me-1" />
  {/if}
  {text}
</Link>
