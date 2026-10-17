<script lang="ts">
  import { createMessageFormatter, type InterpolationValues } from '$lib/elements/format-message';
  import { locale as i18nLocale, json, type Translations } from 'svelte-i18n';

  interface Props {
    key: Translations;
    values?: InterpolationValues;
    children?: import('svelte').Snippet<[{ tag?: string; message?: string }]>;
  }

  let { key, values = {}, children }: Props = $props();

  const getLocale = (locale?: string | null) => {
    if (!locale) {
      throw new Error('Cannot format a message without first setting the initial locale.');
    }

    return locale;
  };

  const getParts = (format: ReturnType<typeof createMessageFormatter>) => {
    try {
      return format(values);
    } catch (error) {
      if (error instanceof Error) {
        console.warn(`Message "${key}" has syntax error:`, error.message);
      }
      return [{ message, tag: undefined }];
    }
  };

  let message = $derived(($json(key) as string) || key);
  let locale = $derived(getLocale($i18nLocale));
  let formatter = $derived(createMessageFormatter(message, locale));
  let parts = $derived(getParts(formatter));
</script>

<!--
@component
Formats an [ICU message](https://formatjs.io/docs/core-concepts/icu-syntax) that contains HTML tags

### Props
- `key` - Key of a defined message
- `values` - Object with a value for each placeholder in the message (optional)

### Default Slot
Used for every occurrence of an HTML tag in a message
- `tag` - Name of the tag
- `message` - Formatted text inside the tag

@example
```svelte
{"message": "Visit <link>docs</link> <b>{time}</b>"}
<FormattedMessage key="message" values={{ time: 'now' }} let:tag let:message>
  {#if tag === 'link'}
    <a href="">{message}</a>
  {:else if tag === 'b'}
    <strong>{message}</strong>
  {/if}
</FormattedMessage>

Result: Visit <a href="">docs</a> <strong>now</strong>
```
-->
<!-- eslint-disable-next-line svelte/require-each-key -->
{#each parts as { tag, message }}
  {#if tag}
    {#if children}{@render children({ tag, message })}{:else}{message}{/if}
  {:else}
    {message}
  {/if}
{/each}
