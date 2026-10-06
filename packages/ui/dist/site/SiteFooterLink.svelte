<script lang="ts">
  import Link from '../components/Link/Link.svelte';
  import Text from '../components/Text/Text.svelte';

  type Props = {
    href: string;
    text: string;
  };

  let { href, text }: Props = $props();
</script>

<Link {href} underline={false} class="text-dark/90 hover:text-primary transition-colors">
  <Text>{text}</Text>
</Link>
