<script lang="ts">
  /**
   * One workflow step parameter (FL-82), ported from `Parameter` in the design template's
   * `WorkflowDesigner.jsx`: objects as fieldsets in the plugin's order, lists of choices, tag and album
   * references, switches, choices and text or number fields. Every edit goes through
   * `updateWorkflowParameter`, so fields the schema does not describe stay as they are, and a value
   * outside the schema's choices is shown as the current value instead of being dropped.
   *
   * Credential parameters are write-only: a stored value is never shown, only replaced or removed.
   */
  import Self from '$lib/components/frameleaf/WorkflowParameter.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import type { ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import {
    isWorkflowReferenceKind,
    resolveWorkflowReferences,
    searchWorkflowReferences,
  } from '$lib/frameleaf/workflow-references';
  import {
    isArraySchema,
    isCredentialKey,
    isObjectSchema,
    orderedProperties,
    updateWorkflowParameter,
    type WorkflowParameterSchema,
  } from '$lib/frameleaf/workflows';
  import { onDestroy } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  let {
    schema,
    value,
    label,
    name = '',
    path = [],
    required = false,
    disabled = false,
    storedSecrets = [],
    onChange,
  }: {
    schema: WorkflowParameterSchema;
    value: unknown;
    label: string;
    /** The parameter's key; decides whether it is a credential. */
    name?: string;
    /** The key path from the step's parameters, to match stored credentials. */
    path?: string[];
    required?: boolean;
    disabled?: boolean;
    storedSecrets?: string[];
    onChange: (next: unknown) => void;
  } = $props();

  const id = $props.id();
  const entries = $derived(Array.isArray(value) ? (value as unknown[]) : []);
  // FL-647: tag and album choices are searched for as the person types, not loaded all at once
  const referenceKind = $derived(isWorkflowReferenceKind(schema.uiHint?.type) ? schema.uiHint.type : undefined);
  const referenceNames = new SvelteMap<string, string>();
  const attempted = new Set<string>();
  let resolving = $state(false);
  let matches = $state<ComboBoxOption[]>([]);
  let picked = $state<ComboBoxOption | undefined>();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchAbort: AbortController | undefined;
  const isCredential = $derived(isCredentialKey(name));
  const hasStoredSecret = $derived(isCredential && value === undefined && storedSecrets.includes(path.join('.')));
  const numeric = $derived(schema.type === 'number' || schema.type === 'integer');
  const referenceLabel = (itemId: string) =>
    referenceNames.get(itemId) ??
    (resolving ? itemId : $t('frameleaf_workflows.unavailable_selection', { values: { id: itemId } }));

  // a saved workflow's choices are shown by name: read only the ones chosen
  $effect(() => {
    const kind = referenceKind;
    // each choice is read at most once: one that cannot be read stays an unavailable selection
    const ids = entries.map(String).filter((itemId) => !referenceNames.has(itemId) && !attempted.has(itemId));
    if (!kind || ids.length === 0) {
      return;
    }
    for (const itemId of ids) {
      attempted.add(itemId);
    }
    let current = true;
    resolving = true;
    void resolveWorkflowReferences(kind, ids)
      .then((found) => {
        if (current) {
          for (const item of found) {
            referenceNames.set(item.id, item.label);
          }
        }
      })
      .finally(() => {
        if (current) {
          resolving = false;
        }
      });
    return () => {
      current = false;
    };
  });

  const searchReferences = (query: string) => {
    const kind = referenceKind;
    if (!kind) {
      return;
    }
    clearTimeout(searchTimer);
    searchAbort?.abort();
    const abort = new AbortController();
    searchAbort = abort;
    searchTimer = setTimeout(
      () => {
        searchWorkflowReferences(kind, query, abort.signal)
          .then((found) => {
            if (abort.signal.aborted) {
              return;
            }
            for (const item of found) {
              referenceNames.set(item.id, item.label);
            }
            matches = found.map((item) => ({ id: item.id, label: item.label, value: item.id }));
          })
          .catch(() => {
            // identifiers can still be entered directly
          });
      },
      query ? 250 : 0,
    );
  };

  const addReference = (option: ComboBoxOption | undefined) => {
    if (option && !entries.includes(option.value)) {
      onChange([...entries, option.value]);
    }
    picked = undefined;
  };

  onDestroy(() => {
    clearTimeout(searchTimer);
    searchAbort?.abort();
  });
  const lines = (text: string) =>
    text
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
</script>

{#if isObjectSchema(schema)}
  <fieldset class="wd-object" {disabled}>
    <legend>{label}{required ? ' *' : ''}</legend>
    {#if schema.description}<p>{schema.description}</p>{/if}
    {#each orderedProperties(schema) as [key, child] (key)}
      <Self
        schema={child}
        name={key}
        path={[...path, key]}
        label={child.title ?? key}
        required={schema.required?.includes(key)}
        value={(value as Record<string, unknown> | undefined)?.[key]}
        {disabled}
        {storedSecrets}
        onChange={(next) => onChange(updateWorkflowParameter(value ?? {}, [key], next))}
      />
    {/each}
  </fieldset>
{:else if isArraySchema(schema) && referenceKind}
  <fieldset class="wd-object" {disabled}>
    <legend>{label}{required ? ' *' : ''}</legend>
    <div class="wd-reference-values">
      {#each entries as entry, index (`${index}:${String(entry)}`)}
        <span>
          {referenceLabel(String(entry))}
          <Button
            {disabled}
            label={$t('frameleaf_workflows.remove_named', { values: { name: referenceLabel(String(entry)) } })}
            onclick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            {$t('frameleaf_workflows.remove')}
          </Button>
        </span>
      {/each}
    </div>
    <div class="wd-field">
      <Picker
        label={referenceKind === 'TagId' ? $t('frameleaf_workflows.find_tag') : $t('frameleaf_workflows.find_album')}
        placeholder={$t('frameleaf_workflows.choose_to_add')}
        options={matches.filter((item) => !entries.includes(item.value))}
        bind:selectedOption={picked}
        {disabled}
        onSearch={searchReferences}
        onSelect={addReference}
      />
    </div>
    <details>
      <summary>{$t('frameleaf_workflows.advanced_identifiers')}</summary>
      <textarea
        aria-label={label}
        {disabled}
        rows={3}
        value={entries.join('\n')}
        onchange={(event) => onChange(lines(event.currentTarget.value))}></textarea>
      <small>{$t('frameleaf_workflows.identifiers_help')}</small>
    </details>
  </fieldset>
{:else if isArraySchema(schema)}
  <fieldset class="wd-object" {disabled}>
    <legend>{label}{required ? ' *' : ''}</legend>
    {#if schema.description}<p>{schema.description}</p>{/if}
    {#if schema.enum}
      <div class="wd-enum-list">
        {#each [...new Set([...schema.enum, ...entries])] as option (String(option))}
          <label>
            <input
              type="checkbox"
              checked={entries.includes(option)}
              onchange={(event) =>
                onChange(
                  event.currentTarget.checked ? [...entries, option] : entries.filter((entry) => entry !== option),
                )}
            />
            {schema.enum.includes(option)
              ? String(option)
              : $t('frameleaf_workflows.unavailable_option', { values: { option: String(option) } })}
          </label>
        {/each}
      </div>
    {:else}
      <label class="wd-field">
        {schema.uiHint?.type === 'TagId'
          ? $t('frameleaf_workflows.tag_identifiers')
          : schema.uiHint?.type === 'AlbumId'
            ? $t('frameleaf_workflows.album_identifiers')
            : $t('frameleaf_workflows.values_one_per_line')}
        <textarea rows={3} value={entries.join('\n')} onchange={(event) => onChange(lines(event.currentTarget.value))}
        ></textarea>
      </label>
    {/if}
    {#if schema.uiHint?.type}
      <small>
        {$t('frameleaf_workflows.use_identifiers', {
          values: { kind: schema.uiHint.type === 'TagId' ? 'tags' : 'albums' },
        })}
      </small>
    {/if}
  </fieldset>
{:else if schema.type === 'boolean'}
  <label class="wd-check">
    <input
      type="checkbox"
      checked={value === true}
      {disabled}
      onchange={(event) => onChange(event.currentTarget.checked)}
    />
    <span>
      {label}
      {#if schema.description}<small>{schema.description}</small>{/if}
    </span>
  </label>
{:else if schema.enum}
  <label class="wd-field">
    {label}{required ? ' *' : ''}
    <select {disabled} value={value ?? ''} onchange={(event) => onChange(event.currentTarget.value || undefined)}>
      {#if !required}<option value="">{$t('frameleaf_workflows.not_set')}</option>{/if}
      {#if value !== undefined && !schema.enum.includes(value)}
        <option {value}>{$t('frameleaf_workflows.current_value', { values: { value: String(value) } })}</option>
      {/if}
      {#each schema.enum as option (String(option))}
        <option value={option}>{String(option)}</option>
      {/each}
    </select>
    {#if schema.description}<small>{schema.description}</small>{/if}
  </label>
{:else}
  <label class="wd-field" for={id}>
    {label}{required ? ' *' : ''}
  </label>
  <input
    {id}
    {disabled}
    type={numeric ? 'number' : isCredential ? 'password' : 'text'}
    value={value ?? ''}
    min={schema.minimum}
    max={schema.maximum}
    step={schema.precision ?? (schema.type === 'integer' ? 1 : 'any')}
    autocomplete="off"
    placeholder={hasStoredSecret ? '••••••••' : undefined}
    oninput={(event) => {
      const text = event.currentTarget.value;
      onChange(text === '' ? undefined : numeric ? Number(text) : text);
    }}
  />
  {#if hasStoredSecret}
    <small>{$t('frameleaf_workflows.stored_secret')}</small>
    <Button {disabled} onclick={() => onChange('')}>{$t('frameleaf_workflows.remove_stored_secret')}</Button>
  {/if}
  {#if schema.description}<small>{schema.description}</small>{/if}
{/if}
