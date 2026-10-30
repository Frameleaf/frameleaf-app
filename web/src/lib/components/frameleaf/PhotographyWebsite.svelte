<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { photographyErrorKey } from '$lib/components/frameleaf/PhotographyStatus.svelte';
  import StudioSite from '$lib/components/frameleaf/StudioSite.svelte';
  import { loadBrand, logoThumbnailUrl, type Brand, type Shoot } from '$lib/frameleaf/photography/api';
  import { PhotographyError } from '$lib/frameleaf/photography/errors';
  import {
    MAX_SITE_PHOTOS,
    moveSection,
    requiredSections,
    seoPreview,
    siteAddress,
    siteItemKey,
    siteItems,
    siteSectionIcons,
    siteTemplates,
    slugify,
    toggleSection,
    validDomain,
    validSlug,
  } from '$lib/frameleaf/photography/studio-site';
  import {
    siteRequest,
    workflowRequest,
    type PublicSite,
    type Site,
    type SiteItem,
    type SitePhoto,
    type SiteSectionId,
    type StudioSite as StoredSite,
    type Workflow,
  } from '$lib/frameleaf/photography/workflow-api';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowDown,
    mdiArrowUp,
    mdiCellphone,
    mdiDragVertical,
    mdiLockOutline,
    mdiMonitor,
    mdiPin,
    mdiPlus,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/photography/studio-site-editor.css';

  /**
   * FL-702: the studio website editor (FL-701 design, approved 2026-10-30). The live preview sits
   * beside one inspector with Design, Sections, Work, Words and Address tabs; every change shows in
   * the preview at once and is kept when Save is pressed.
   */
  let { shoots, onEditBrand }: { shoots: Shoot[]; onEditBrand?: () => void } = $props();

  const tabs = ['design', 'sections', 'work', 'words', 'address'] as const;
  let tab = $state<(typeof tabs)[number]>('design');
  let stored = $state<StoredSite | null>(null);
  let draft = $state<Site | null>(null);
  let brand = $state<Brand | null>(null);
  let workflows = $state<Record<string, Workflow>>({});
  let phone = $state(false);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let collectionId = $state<string | null>(null);
  let pickShoot = $state('');
  let consent = $state(false);
  let dragging = $state<SiteSectionId | null>(null);
  let disposed = false;

  const dirty = $derived(!!stored && !!draft && JSON.stringify(stored.site) !== JSON.stringify(draft));
  const collection = $derived(
    draft?.collections.find((item) => item.id === collectionId) ?? draft?.collections[0] ?? null,
  );
  const items = $derived(draft ? siteItems(draft) : []);
  /** Every capture the editor knows about, by "shoot:capture", for previews and choosing. */
  const captures = $derived(
    new Map(
      Object.entries(workflows).flatMap(([shootId, workflow]) =>
        workflow.captures.map((capture) => [siteItemKey({ shootId, captureId: capture.id }), capture] as const),
      ),
    ),
  );
  const pickable = $derived(
    workflows[pickShoot]?.captures.filter(
      (capture) => capture.eligible && !capture.withheld && capture.approvedRevisionId && capture.assetId,
    ) ?? [],
  );
  const slugOk = $derived(!!draft && validSlug(draft.slug));
  const domainOk = $derived(!!draft && validDomain(draft.domain));
  const seo = $derived(draft ? seoPreview(draft, brand?.tagline || draft.about.slice(0, 160)) : null);
  const origin = typeof location === 'undefined' ? '' : location.origin;

  function photo(item: SiteItem, alt: string): SitePhoto | null {
    const assetId = captures.get(siteItemKey(item))?.assetId;
    return assetId
      ? {
          key: siteItemKey(item),
          alt,
          width: 0,
          height: 0,
          url: getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Preview }),
          srcset: '',
        }
      : null;
  }

  /** The preview shows the draft with the owner's own previews; the public site uses its own copies. */
  const preview = $derived.by((): PublicSite | null => {
    if (!draft) {
      return null;
    }
    const site = draft;
    return {
      ownerId: '',
      template: site.template,
      colours: site.colours,
      coverFocal: site.coverFocal,
      sections: site.sections,
      title: site.title,
      about: site.about,
      contact: site.contact,
      packages: site.packages.filter((item) => item.name.trim()),
      testimonials: site.testimonials.filter((item) => item.quote.trim()),
      faq: site.faq.filter((item) => item.q.trim()),
      trustedBy: site.trustedBy,
      cover: site.cover ? photo(site.cover, site.title) : null,
      collections: site.collections.map((item) => ({
        id: item.id,
        name: item.name,
        photos: item.items
          .map((entry, index) => photo(entry, `${item.name}, ${index + 1}`))
          .filter((entry): entry is SitePhoto => !!entry),
      })),
      brand: {
        name: brand?.name || site.title,
        tagline: brand?.tagline ?? '',
        email: brand?.email ?? '',
        phone: brand?.phone ?? '',
        color: brand?.color ?? '#577059',
        background: brand?.background ?? '#f5f3ed',
        textColor: brand?.textColor ?? '#263329',
        font: brand?.font ?? 'editorial',
        logoUrl: brand?.logoAssetId ? logoThumbnailUrl(brand.logoAssetId) : null,
      },
    };
  });

  async function loadWorkflow(shootId: string) {
    // The shoot list may still be loading, so ask for any shoot; the server refuses one that is not the studio's.
    if (Object.hasOwn(workflows, shootId) || shoots.find((shoot) => shoot.id === shootId)?.unavailable) {
      return;
    }
    try {
      const workflow = await workflowRequest<Workflow>(shootId);
      if (!disposed) {
        workflows = { ...workflows, [shootId]: workflow };
      }
    } catch {
      // A shoot that can no longer be read simply shows no preview for its photographs.
    }
  }

  async function reload() {
    busy = true;
    error = '';
    try {
      const [site, branding] = await Promise.all([siteRequest(), loadBrand().catch(() => null)]);
      if (disposed) {
        return;
      }
      stored = site;
      draft = structuredClone(site.site);
      brand = branding?.brand ?? null;
      await Promise.all([...new Set(siteItems(site.site).map((item) => item.shootId))].map((id) => loadWorkflow(id)));
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }

  async function save() {
    if (!draft || !stored || busy || !slugOk || !domainOk) {
      return;
    }
    busy = true;
    error = '';
    message = '';
    try {
      const result = await siteRequest('PUT', { expectedRevision: stored.revision, site: $state.snapshot(draft) });
      if (disposed) {
        return;
      }
      stored = result;
      draft = structuredClone(result.site);
      message = result.site.enabled
        ? $t('frameleaf_photography_site_saved_published')
        : $t('frameleaf_photography_site_saved');
    } catch (error_) {
      if (!disposed) {
        error =
          error_ instanceof PhotographyError && error_.status === 409 && draft.slug !== stored.site.slug
            ? $t('frameleaf_studio_site_address_taken')
            : $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }

  function toggleItem(item: SiteItem) {
    if (!draft || !collection) {
      return;
    }
    const key = siteItemKey(item);
    const at = collection.items.findIndex((entry) => siteItemKey(entry) === key);
    if (at !== -1) {
      collection.items.splice(at, 1);
      dropCoverIfUnused();
    } else if (consent && items.length < MAX_SITE_PHOTOS) {
      collection.items.push(item);
      draft.cover ??= item;
    }
  }

  function addCollection() {
    if (!draft || draft.collections.length >= 12) {
      return;
    }
    const id = `collection-${Date.now().toString(36)}`;
    draft.collections.push({ id, name: $t('frameleaf_studio_site_new_collection'), items: [] });
    collectionId = id;
  }

  function removeCollection() {
    if (!draft || !collection || draft.collections.length < 2) {
      return;
    }
    draft.collections = draft.collections.filter((item) => item.id !== collection.id);
    dropCoverIfUnused();
    collectionId = null;
  }

  /** The cover is one of the website's photographs; once no collection holds it, it goes too. */
  function dropCoverIfUnused() {
    if (!draft?.cover) {
      return;
    }
    const cover = siteItemKey(draft.cover);
    if (draft.collections.every((item) => item.items.every((entry) => siteItemKey(entry) !== cover))) {
      draft.cover = null;
    }
  }

  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

<div class="phd" aria-busy={busy}>
  <div class="phd-toolbar">
    <div>
      <span class="phd-eyebrow">{$t('frameleaf_photography_site_eyebrow')}</span>
      <h2>{$t('frameleaf_photography_studio_website')}</h2>
      <p>{$t('frameleaf_photography_site_lead')}</p>
    </div>
    <div class="phd-actions">
      {#if draft}
        <label class="sse-switch"
          ><input type="checkbox" role="switch" bind:checked={draft.enabled} />{$t(
            'frameleaf_photography_site_publish',
          )}</label
        >
      {/if}
      {#if stored?.site.enabled}<a class="fl-control" href={stored.url} target="_blank" rel="noopener"
          >{$t('frameleaf_photography_site_open')} ↗</a
        >{/if}
      <Button variant="primary" disabled={busy || !draft || !dirty || !slugOk || !domainOk} onclick={save}
        >{$t('frameleaf_photography_site_save')}</Button
      >
    </div>
  </div>
  {#if error}<p class="sse-notice" role="alert">{error}</p>{/if}
  {#if message}<p class="sse-notice" role="status">{message}</p>{/if}

  {#if draft && preview}
    <div class="sse">
      <section class="sse-stage" aria-label={$t('frameleaf_studio_site_preview')}>
        <div class="sse-bar">
          <span class="sse-address"
            ><Icon icon={mdiLockOutline} size="14" aria-hidden={true} />{siteAddress(draft, origin).replace(
              /^https?:\/\//,
              '',
            )}</span
          >
          <span class="grow"></span>
          <Button pressed={!phone} label={$t('frameleaf_studio_site_desktop')} onclick={() => (phone = false)}
            ><Icon icon={mdiMonitor} size="18" aria-hidden={true} /></Button
          >
          <Button pressed={phone} label={$t('frameleaf_studio_site_phone')} onclick={() => (phone = true)}
            ><Icon icon={mdiCellphone} size="18" aria-hidden={true} /></Button
          >
        </div>
        <div class="sse-frame" class:is-phone={phone}>
          <StudioSite site={preview} />
        </div>
      </section>

      <aside class="sse-inspector">
        <div class="sse-tabs" role="tablist" aria-label={$t('frameleaf_studio_site_settings')}>
          {#each tabs as name (name)}
            <button type="button" role="tab" aria-selected={tab === name} onclick={() => (tab = name)}
              >{$t(`frameleaf_studio_site_tab_${name}`)}</button
            >
          {/each}
        </div>

        <div class="sse-body" role="tabpanel">
          {#if tab === 'design'}
            <h2>{$t('frameleaf_studio_site_template')}</h2>
            <div class="sse-templates">
              {#each siteTemplates as template (template.id)}
                <div class="sse-template" data-selected={draft.template === template.id || undefined}>
                  <span class="sse-template-view" aria-hidden="true">
                    <StudioSite thumbnail site={{ ...preview, template: template.id }} />
                  </span>
                  <button
                    type="button"
                    aria-pressed={draft.template === template.id}
                    onclick={() => (draft!.template = template.id)}
                  >
                    <strong>{$t(`frameleaf_studio_site_template_${template.id}`)}</strong>
                    <small>{$t(`frameleaf_studio_site_template_${template.id}_for`)}</small>
                  </button>
                </div>
              {/each}
            </div>
            <p class="sse-help">{$t(`frameleaf_studio_site_template_${draft.template}_about`)}</p>
            <fieldset class="sse-choice">
              <legend>{$t('frameleaf_studio_site_colours')}</legend>
              <label
                ><input type="radio" name="sse-colours" value="template" bind:group={draft.colours} />{$t(
                  'frameleaf_studio_site_colours_template',
                )}</label
              >
              <label
                ><input type="radio" name="sse-colours" value="brand" bind:group={draft.colours} />{$t(
                  'frameleaf_studio_site_colours_brand',
                )}</label
              >
              <small
                >{$t('frameleaf_studio_site_colours_hint')}
                {#if onEditBrand}<button type="button" class="sse-link" onclick={onEditBrand}
                    >{$t('frameleaf_studio_site_edit_brand')}</button
                  >{/if}</small
              >
            </fieldset>
            <h2>{$t('frameleaf_studio_site_cover')}</h2>
            {#if items.length > 0}
              <div class="sse-cover-pick">
                {#each items as item (siteItemKey(item))}
                  {@const assetId = captures.get(siteItemKey(item))?.assetId}
                  <button
                    type="button"
                    aria-pressed={!!draft.cover && siteItemKey(draft.cover) === siteItemKey(item)}
                    aria-label={$t('frameleaf_studio_site_use_as_cover')}
                    onclick={() => (draft!.cover = item)}
                  >
                    {#if assetId}<img
                        src={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail })}
                        alt=""
                      />{/if}
                  </button>
                {/each}
              </div>
            {:else}
              <p class="sse-help">{$t('frameleaf_studio_site_cover_empty')}</p>
            {/if}
            <label class="sse-field"
              ><span>{$t('frameleaf_studio_site_keep_in_view')}</span><input
                type="range"
                min="0"
                max="100"
                bind:value={draft.coverFocal}
              /><small>{$t('frameleaf_studio_site_keep_in_view_hint')}</small></label
            >
          {:else if tab === 'sections'}
            <h2>{$t('frameleaf_studio_site_sections')}</h2>
            <p class="sse-help">{$t('frameleaf_studio_site_sections_hint')}</p>
            <ol class="sse-sections">
              {#each draft.sections as section, index (section.id)}
                {@const label = $t(`frameleaf_studio_site_section_${section.id}`)}
                <li
                  draggable={index > 0}
                  class:is-dragging={dragging === section.id}
                  ondragstart={() => (dragging = section.id)}
                  ondragend={() => (dragging = null)}
                  ondragover={(event) => {
                    if (!dragging || dragging === section.id || index < 1) {
                      return;
                    }
                    event.preventDefault();
                    const from = draft!.sections.findIndex((item) => item.id === dragging);
                    draft!.sections = moveSection(draft!.sections, dragging, index - from);
                  }}
                >
                  <Icon icon={index ? mdiDragVertical : mdiPin} size="16" aria-hidden={true} />
                  <Icon icon={siteSectionIcons[section.id]} size="16" aria-hidden={true} />
                  <span>{label}</span>
                  <Button
                    label={$t('frameleaf_studio_site_move_up', { values: { section: label } })}
                    disabled={index < 2}
                    onclick={() => (draft!.sections = moveSection(draft!.sections, section.id, -1))}
                    ><Icon icon={mdiArrowUp} size="16" aria-hidden={true} /></Button
                  >
                  <Button
                    label={$t('frameleaf_studio_site_move_down', { values: { section: label } })}
                    disabled={index < 1 || index === draft.sections.length - 1}
                    onclick={() => (draft!.sections = moveSection(draft!.sections, section.id, 1))}
                    ><Icon icon={mdiArrowDown} size="16" aria-hidden={true} /></Button
                  >
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={$t('frameleaf_studio_site_show_section', { values: { section: label } })}
                    checked={section.on}
                    disabled={requiredSections.includes(section.id)}
                    onchange={() => (draft!.sections = toggleSection(draft!.sections, section.id))}
                  />
                </li>
              {/each}
            </ol>
          {:else if tab === 'work'}
            <h2>{$t('frameleaf_studio_site_collections')}</h2>
            <p class="sse-help">{$t('frameleaf_studio_site_collections_hint')}</p>
            <div class="sse-collection-list">
              {#each draft.collections as item (item.id)}
                <button type="button" aria-pressed={item.id === collection?.id} onclick={() => (collectionId = item.id)}
                  >{item.name}<small>{item.items.length}</small></button
                >
              {/each}
              <Button disabled={draft.collections.length >= 12} onclick={addCollection}
                ><Icon icon={mdiPlus} size="16" aria-hidden={true} />{$t('frameleaf_studio_site_collection')}</Button
              >
            </div>
            {#if collection}
              <label class="sse-field"
                ><span>{$t('frameleaf_studio_site_collection_name')}</span><input
                  maxlength="60"
                  bind:value={collection.name}
                /></label
              >
              {#if collection.items.length > 0}
                <div class="sse-photo-pick">
                  {#each collection.items as item, index (siteItemKey(item))}
                    {@const assetId = captures.get(siteItemKey(item))?.assetId}
                    <button
                      type="button"
                      aria-pressed="true"
                      aria-label={$t('frameleaf_studio_site_remove_photo', { values: { number: index + 1 } })}
                      onclick={() => toggleItem(item)}
                      >{#if assetId}<img
                          src={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail })}
                          alt=""
                        />{/if}<span>{index + 1}</span></button
                    >
                  {/each}
                </div>
              {/if}
              <label class="sse-field"
                ><span>{$t('frameleaf_studio_site_add_from')}</span><select
                  bind:value={pickShoot}
                  onchange={() => void loadWorkflow(pickShoot)}
                >
                  <option value="">{$t('frameleaf_photography_choose_shoot')}</option>
                  {#each shoots.filter((shoot) => !shoot.unavailable) as shoot (shoot.id)}
                    <option value={shoot.id}>{shoot.name}</option>
                  {/each}
                </select></label
              >
              {#if pickShoot}
                <label class="sse-consent"
                  ><input type="checkbox" bind:checked={consent} />{$t('frameleaf_photography_site_consent')}</label
                >
                <div class="sse-photo-pick">
                  {#each pickable as capture (capture.id)}
                    {@const item = { shootId: pickShoot, captureId: capture.id }}
                    {@const at = collection.items.findIndex((entry) => siteItemKey(entry) === siteItemKey(item))}
                    <button
                      type="button"
                      aria-pressed={at >= 0}
                      disabled={at < 0 && (!consent || items.length >= MAX_SITE_PHOTOS)}
                      aria-label={$t('frameleaf_photography_photo_number', { values: { number: capture.number } })}
                      onclick={() => toggleItem(item)}
                      ><img
                        src={getAssetMediaUrl({ id: capture.assetId!, size: AssetMediaSize.Thumbnail })}
                        alt=""
                      />{#if at >= 0}<span>{at + 1}</span>{/if}</button
                    >
                  {:else}
                    <p class="sse-help">{$t('frameleaf_photography_site_none_ready')}</p>
                  {/each}
                </div>
              {/if}
              <small class="sse-small"
                >{$t('frameleaf_studio_site_photo_limit', {
                  values: { count: items.length, max: MAX_SITE_PHOTOS },
                })}</small
              >
              <Button variant="danger" disabled={draft.collections.length < 2} onclick={removeCollection}
                >{$t('frameleaf_studio_site_delete_collection')}</Button
              >
            {/if}
          {:else if tab === 'words'}
            <label class="sse-field"
              ><span>{$t('frameleaf_photography_site_title')}</span><input
                required
                maxlength="200"
                bind:value={draft.title}
              /></label
            >
            <label class="sse-field"
              ><span>{$t('frameleaf_photography_site_about')}</span><textarea
                rows="5"
                maxlength="10000"
                bind:value={draft.about}></textarea></label
            >
            <label class="sse-field"
              ><span>{$t('frameleaf_photography_site_contact_intro')}</span><textarea
                rows="3"
                maxlength="5000"
                bind:value={draft.contact}></textarea></label
            >
            <div class="sse-row">
              <h2>{$t('frameleaf_studio_site_services')}</h2>
              <Button
                disabled={draft.packages.length >= 12}
                onclick={() => {
                  draft!.packages.push({ name: '', price: '', detail: '' });
                }}><Icon icon={mdiPlus} size="16" aria-hidden={true} />{$t('frameleaf_studio_site_add')}</Button
              >
            </div>
            {#each draft.packages as item, index (index)}
              <div class="sse-package">
                <input
                  aria-label={$t('frameleaf_studio_site_package_name', { values: { number: index + 1 } })}
                  placeholder={$t('frameleaf_studio_site_package_name_placeholder')}
                  maxlength="80"
                  bind:value={item.name}
                />
                <input
                  aria-label={$t('frameleaf_studio_site_package_price', { values: { number: index + 1 } })}
                  placeholder={$t('frameleaf_studio_site_package_price_placeholder')}
                  maxlength="40"
                  bind:value={item.price}
                />
                <textarea
                  rows="2"
                  aria-label={$t('frameleaf_studio_site_package_detail', { values: { number: index + 1 } })}
                  maxlength="400"
                  bind:value={item.detail}></textarea>
                <Button variant="quiet" onclick={() => draft!.packages.splice(index, 1)}>{$t('remove')}</Button>
              </div>
            {/each}
            <div class="sse-row">
              <h2>{$t('frameleaf_studio_site_kind_words')}</h2>
              <Button
                disabled={draft.testimonials.length >= 12}
                onclick={() => {
                  draft!.testimonials.push({ quote: '', name: '' });
                }}><Icon icon={mdiPlus} size="16" aria-hidden={true} />{$t('frameleaf_studio_site_add')}</Button
              >
            </div>
            {#each draft.testimonials as item, index (index)}
              <div class="sse-package">
                <textarea
                  rows="2"
                  aria-label={$t('frameleaf_studio_site_quote', { values: { number: index + 1 } })}
                  maxlength="600"
                  bind:value={item.quote}></textarea>
                <input
                  aria-label={$t('frameleaf_studio_site_quote_from', { values: { number: index + 1 } })}
                  maxlength="80"
                  bind:value={item.name}
                />
                <Button variant="quiet" onclick={() => draft!.testimonials.splice(index, 1)}>{$t('remove')}</Button>
              </div>
            {/each}
            <div class="sse-row">
              <h2>{$t('frameleaf_studio_site_questions')}</h2>
              <Button
                disabled={draft.faq.length >= 20}
                onclick={() => {
                  draft!.faq.push({ q: '', a: '' });
                }}><Icon icon={mdiPlus} size="16" aria-hidden={true} />{$t('frameleaf_studio_site_add')}</Button
              >
            </div>
            {#each draft.faq as item, index (index)}
              <div class="sse-package">
                <input
                  aria-label={$t('frameleaf_studio_site_question', { values: { number: index + 1 } })}
                  maxlength="200"
                  bind:value={item.q}
                />
                <textarea
                  rows="2"
                  aria-label={$t('frameleaf_studio_site_answer', { values: { number: index + 1 } })}
                  maxlength="2000"
                  bind:value={item.a}></textarea>
                <Button variant="quiet" onclick={() => draft!.faq.splice(index, 1)}>{$t('remove')}</Button>
              </div>
            {/each}
            {#if draft.template === 'commercial'}
              <label class="sse-field"
                ><span>{$t('frameleaf_studio_site_trusted_by')}</span><input
                  value={draft.trustedBy.join(', ')}
                  onchange={(event) =>
                    (draft!.trustedBy = event.currentTarget.value
                      .split(',')
                      .map((name) => name.trim())
                      .filter(Boolean)
                      .slice(0, 12))}
                /><small>{$t('frameleaf_studio_site_trusted_by_hint')}</small></label
              >
            {/if}
          {:else if tab === 'address'}
            <h2>{$t('frameleaf_studio_site_address')}</h2>
            <label class="sse-field"
              ><span>{$t('frameleaf_studio_site_frameleaf_address')}</span><input
                value={draft.slug}
                maxlength="48"
                aria-invalid={!slugOk}
                oninput={(event) => (draft!.slug = slugify(event.currentTarget.value))}
              /><small>{slugOk ? `${origin}/studio/${draft.slug}` : $t('frameleaf_studio_site_address_invalid')}</small
              ></label
            >
            <label class="sse-field"
              ><span>{$t('frameleaf_studio_site_domain')}</span><input
                placeholder="cedarandlight.ca"
                maxlength="253"
                aria-invalid={!domainOk}
                bind:value={draft.domain}
              /><small
                >{!domainOk
                  ? $t('frameleaf_studio_site_domain_invalid')
                  : draft.domain
                    ? $t('frameleaf_studio_site_domain_cname')
                    : $t('frameleaf_studio_site_domain_hint')}</small
              ></label
            >
            <h2>{$t('frameleaf_studio_site_search_sharing')}</h2>
            <label class="sse-field"
              ><span>{$t('frameleaf_studio_site_page_title')}</span><input
                maxlength="120"
                placeholder={draft.title}
                bind:value={draft.seoTitle}
              />{#if seo?.titleLong}<small>{$t('frameleaf_studio_site_cut_short')}</small>{/if}</label
            >
            <label class="sse-field"
              ><span>{$t('frameleaf_studio_site_page_description')}</span><textarea
                rows="3"
                maxlength="300"
                bind:value={draft.seoDescription}></textarea>{#if seo?.descriptionLong}<small
                  >{$t('frameleaf_studio_site_cut_short')}</small
                >{/if}</label
            >
            {#if seo}
              <div class="sse-serp" aria-label={$t('frameleaf_studio_site_search_preview')}>
                <small>{siteAddress(draft, origin).replace(/^https?:\/\//, '')}</small>
                <strong>{seo.title}</strong>
                <p>{seo.description}</p>
              </div>
              <div class="sse-share" aria-label={$t('frameleaf_studio_site_link_preview')}>
                {#if preview.cover}<img src={preview.cover.url} alt="" />{/if}
                <span
                  ><small>{siteAddress(draft, origin).replace(/^https?:\/\//, '')}</small><strong>{seo.title}</strong
                  ></span
                >
              </div>
            {/if}
            <h2>{$t('frameleaf_studio_site_inquiries')}</h2>
            {#if stored && stored.inquiries.length > 0}
              <ul class="sse-inquiries">
                {#each stored.inquiries.slice(0, 20) as item (item.id)}
                  <li>
                    {#if item.kind === 'gallery-link'}
                      <strong>{$t('frameleaf_studio_site_gallery_link_request')}</strong>
                      <a href={`mailto:${item.email}`}>{item.email}</a>
                    {:else}
                      <strong>{item.name}</strong>{item.type ? ` · ${item.type}` : ''}{item.date
                        ? ` · ${item.date}`
                        : ''}
                      <a href={`mailto:${item.email}`}>{item.email}</a>
                      <small>{item.message}</small>
                    {/if}
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="sse-help">{$t('frameleaf_studio_site_inquiries_empty')}</p>
            {/if}
          {/if}
        </div>
      </aside>
    </div>
  {:else}
    <p role="status">
      {busy ? $t('frameleaf_photography_site_loading') : $t('frameleaf_photography_reload_to_retry')}
    </p>
    {#if !busy}<Button onclick={reload}>{$t('frameleaf_photography_reload')}</Button>{/if}
  {/if}
</div>
