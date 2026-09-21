<script lang="ts">
  let { url, altText }: { url: string; altText: string } = $props();
</script>

<img src={url} alt={altText} />
