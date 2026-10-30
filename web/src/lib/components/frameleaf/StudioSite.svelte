<script lang="ts">
  import { inquiryProblems, sectionOn, siteTemplate } from '$lib/frameleaf/photography/studio-site';
  import type { InquiryInput, PublicSite, SitePhoto } from '$lib/frameleaf/photography/workflow-api';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/photography/studio-site.css';

  /**
   * FL-702: the public studio website, one renderer for all six templates (FL-701 design). The
   * template changes markup only where the layout truly differs (cover, collections); CSS does the
   * rest, sized by container queries so the editor's phone frame shows the real phone layout.
   */
  let {
    site,
    thumbnail = false,
    onInquiry,
  }: {
    site: PublicSite;
    /** A small, inert render for the template picker. */
    thumbnail?: boolean;
    /** Sends an inquiry; absent in the editor's preview, where nothing is sent. */
    onInquiry?: (inquiry: InquiryInput) => Promise<void>;
  } = $props();

  const template = $derived(siteTemplate(site.template));
  const collections = $derived(site.collections.filter((collection) => collection.photos.length > 0));
  let chosen = $state<string | null>(null);
  const current = $derived(collections.find((collection) => collection.id === chosen) ?? collections[0]);
  const cover = $derived(site.cover ?? current?.photos[0] ?? null);
  const brandColours = $derived(site.colours === 'brand');
  const on = $derived(site.sections.filter((section) => section.on));
  const has = (id: PublicSite['sections'][number]['id']) => sectionOn(site.sections, id);
  const style = $derived(
    [
      `--ss-accent:${site.brand.color}`,
      `--ss-paper:${brandColours ? site.brand.background : template.paper}`,
      `--ss-text:${brandColours ? site.brand.textColor : template.text}`,
      `--ss-focal:50% ${site.coverFocal}%`,
    ].join(';'),
  );
  const filmFrames = $derived(
    [cover, ...(current?.photos ?? []).filter((photo) => photo.key !== cover?.key)]
      .filter((photo): photo is SitePhoto => !!photo)
      .slice(0, 3),
  );
  const tabIndex = $derived(thumbnail ? -1 : undefined);

  const blank = (): InquiryInput => ({ kind: 'inquiry', name: '', email: '', date: '', type: '', message: '' });
  let inquiry = $state(blank());
  let honeypot = $state('');
  let problems = $state<ReturnType<typeof inquiryProblems>>([]);
  let sending = $state(false);
  let sent = $state<'sent' | 'preview' | null>(null);
  let failed = $state(false);
  let galleryEmail = $state('');
  let galleryAsked = $state(false);

  const types = ['portrait', 'family', 'wedding', 'brand', 'other'] as const;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    problems = inquiryProblems(inquiry);
    if (problems.length > 0 || sending) {
      return;
    }
    if (!onInquiry) {
      sent = 'preview';
      return;
    }
    sending = true;
    failed = false;
    try {
      await onInquiry({ ...$state.snapshot(inquiry), website: honeypot || undefined });
      sent = 'sent';
    } catch {
      failed = true;
    } finally {
      sending = false;
    }
  }

  async function askForGallery(event: SubmitEvent) {
    event.preventDefault();
    if (sending) {
      return;
    }
    sending = true;
    try {
      await onInquiry?.({ kind: 'gallery-link', name: '', email: galleryEmail, date: '', type: '', message: '' });
    } catch {
      // Same answer whatever happened, so the form never reveals whether an address has a gallery.
    } finally {
      sending = false;
      galleryAsked = true;
    }
  }
</script>

{#snippet image(photo: SitePhoto, sizes: string, lazy = true)}
  <img
    src={photo.url}
    srcset={photo.srcset || undefined}
    {sizes}
    width={photo.width || undefined}
    height={photo.height || undefined}
    alt={photo.alt}
    loading={lazy && !thumbnail ? 'lazy' : undefined}
    decoding="async"
  />
{/snippet}

{#snippet action()}
  {#if has('inquiry')}<a class="ss-cta" href="#ss-inquiry" tabindex={tabIndex}
      >{site.template === 'commercial'
        ? $t('frameleaf_studio_site_start_project')
        : $t('frameleaf_studio_site_check_availability')}</a
    >{/if}
{/snippet}

{#snippet coverSection()}
  {#if site.template === 'minimal' || site.template === 'commercial'}
    <section class="ss-cover ss-cover-split" id="ss-top">
      <div>
        <p class="ss-kicker">{site.brand.name}</p>
        <h1>{site.brand.tagline || site.title}</h1>
        {@render action()}
        {#if site.template === 'commercial' && site.trustedBy.length > 0}
          <p class="ss-trusted">
            {$t('frameleaf_studio_site_trusted_by')} <span>{site.trustedBy.join(' · ')}</span>
          </p>
        {/if}
      </div>
      {#if cover}{@render image(cover, '(max-width: 640px) 100vw, 50vw', false)}{/if}
    </section>
  {:else if site.template === 'gallery'}
    <section class="ss-cover ss-cover-plate" id="ss-top">
      {#if cover}{@render image(cover, '(max-width: 800px) 100vw, 760px', false)}{/if}
      <h1>{site.brand.name}</h1>
      {#if site.brand.tagline}<p>{site.brand.tagline}</p>{/if}
    </section>
  {:else if site.template === 'cinematic'}
    <section class="ss-cover ss-cover-film" id="ss-top">
      {#each filmFrames as photo, index (photo.key)}
        <img
          src={photo.url}
          srcset={photo.srcset || undefined}
          sizes="100vw"
          alt={index === 0 ? photo.alt : ''}
          style={`--ss-frame:${index};--ss-frames:${filmFrames.length}`}
        />
      {/each}
      <div>
        <h1>{site.brand.tagline || site.title}</h1>
        {@render action()}
      </div>
    </section>
  {:else}
    <section class="ss-cover ss-cover-full" id="ss-top">
      {#if cover}{@render image(cover, site.template === 'noir' ? '50vw' : '100vw', false)}{/if}
      <div>
        <p class="ss-kicker">{site.brand.name}</p>
        <h1>{site.brand.tagline || site.title}</h1>
        {@render action()}
      </div>
    </section>
  {/if}
{/snippet}

{#snippet portfolio()}
  <section class="ss-portfolio" id="ss-portfolio">
    <div class="ss-section-head">
      <h2>{$t('frameleaf_studio_site_selected_work')}</h2>
      {#if collections.length > 1}
        <div class="ss-collections" role="tablist" aria-label={$t('frameleaf_studio_site_collections')}>
          {#each collections as collection (collection.id)}
            <button
              type="button"
              role="tab"
              aria-selected={collection.id === current?.id}
              tabindex={tabIndex}
              onclick={() => (chosen = collection.id)}
            >
              {#if site.template === 'commercial' || site.template === 'cinematic'}
                <img src={collection.photos[0].url} alt="" loading="lazy" />
              {/if}
              <span>{collection.name}</span>
              {#if site.template === 'commercial'}
                <small>{$t('frameleaf_studio_site_photo_count', { values: { count: collection.photos.length } })}</small
                >
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="ss-work">
      {#each current?.photos ?? [] as photo (photo.key)}
        <figure>
          {@render image(photo, '(max-width: 640px) 100vw, 50vw')}
          <figcaption>{photo.alt}</figcaption>
        </figure>
      {/each}
    </div>
  </section>
{/snippet}

{#snippet about()}
  {#if site.about}
    <section class="ss-about" id="ss-about">
      {#if cover}{@render image(cover, '(max-width: 640px) 100vw, 40vw')}{/if}
      <div>
        <p class="ss-kicker">{$t('frameleaf_studio_site_about_kicker')}</p>
        <h2>{$t('frameleaf_studio_site_hello', { values: { name: site.brand.name } })}</h2>
        <p class="ss-prose">{site.about}</p>
      </div>
    </section>
  {/if}
{/snippet}

{#snippet services()}
  {#if site.packages.length > 0}
    <section class="ss-services" id="ss-services">
      <div class="ss-section-head"><h2>{$t('frameleaf_studio_site_services')}</h2></div>
      <div class="ss-packages">
        {#each site.packages as item, index (index)}
          <article>
            <h3>{item.name}</h3>
            {#if item.price}<strong>{item.price}</strong>{/if}
            <p>{item.detail}</p>
          </article>
        {/each}
      </div>
    </section>
  {/if}
{/snippet}

{#snippet testimonials()}
  {#if site.testimonials.length > 0}
    <section class="ss-testimonials" aria-label={$t('frameleaf_studio_site_kind_words')}>
      {#each site.testimonials as item, index (index)}
        <blockquote>
          <p>“{item.quote}”</p>
          <cite>{item.name}</cite>
        </blockquote>
      {/each}
    </section>
  {/if}
{/snippet}

{#snippet faq()}
  {#if site.faq.length > 0}
    <section class="ss-faq">
      <div class="ss-section-head"><h2>{$t('frameleaf_studio_site_questions')}</h2></div>
      {#each site.faq as item, index (index)}
        <details>
          <summary tabindex={tabIndex}>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      {/each}
    </section>
  {/if}
{/snippet}

{#snippet inquirySection()}
  <section class="ss-inquiry" id="ss-inquiry">
    <div>
      <p class="ss-kicker">{$t('frameleaf_studio_site_get_in_touch')}</p>
      <h2>{$t('frameleaf_studio_site_make_together')}</h2>
      {#if site.contact}<p class="ss-prose">{site.contact}</p>{/if}
      {#if site.brand.email || site.brand.phone}
        <p class="ss-direct">
          {#if site.brand.email}<a href={`mailto:${site.brand.email}`} tabindex={tabIndex}>{site.brand.email}</a><br
            />{/if}
          {#if site.brand.phone}<a href={`tel:${site.brand.phone}`} tabindex={tabIndex}>{site.brand.phone}</a>{/if}
        </p>
      {/if}
    </div>
    {#if sent}
      <div class="ss-sent" role="status">
        <h3>{$t('frameleaf_studio_site_thanks', { values: { name: inquiry.name.trim().split(' ', 1)[0] } })}</h3>
        <p>
          {sent === 'preview'
            ? $t('frameleaf_studio_site_preview_not_sent')
            : $t('frameleaf_studio_site_reply_soon', { values: { studio: site.brand.name } })}
        </p>
        <button
          type="button"
          onclick={() => {
            inquiry = blank();
            sent = null;
          }}>{$t('frameleaf_studio_site_send_another')}</button
        >
      </div>
    {:else}
      <form novalidate onsubmit={submit}>
        <label
          >{$t('name')}<input
            autocomplete="name"
            maxlength="120"
            bind:value={inquiry.name}
            aria-invalid={problems.includes('name') || undefined}
            tabindex={tabIndex}
          /></label
        >
        <label
          >{$t('email')}<input
            type="email"
            autocomplete="email"
            maxlength="254"
            bind:value={inquiry.email}
            aria-invalid={problems.includes('email') || undefined}
            tabindex={tabIndex}
          /></label
        >
        <label
          >{$t('frameleaf_studio_site_date')}<input type="date" bind:value={inquiry.date} tabindex={tabIndex} /></label
        >
        <label
          >{$t('frameleaf_studio_site_planning')}<select bind:value={inquiry.type} tabindex={tabIndex}>
            <option value=""></option>
            {#each types as type (type)}
              <option value={$t(`frameleaf_studio_site_type_${type}`)}
                >{$t(`frameleaf_studio_site_type_${type}`)}</option
              >
            {/each}
          </select></label
        >
        <label class="ss-wide"
          >{$t('frameleaf_studio_site_message')}<textarea
            rows="4"
            maxlength="5000"
            bind:value={inquiry.message}
            aria-invalid={problems.includes('message') || undefined}
            tabindex={tabIndex}></textarea></label
        >
        <!-- Left empty by people; form-filling bots fill it and are quietly ignored. -->
        <input
          class="ss-trap"
          name="website"
          tabindex="-1"
          autocomplete="off"
          aria-hidden="true"
          bind:value={honeypot}
        />
        {#if problems.length > 0}
          <ul class="ss-problems ss-wide" role="alert">
            {#each problems as problem (problem)}<li>{$t(`frameleaf_studio_site_needs_${problem}`)}</li>{/each}
          </ul>
        {/if}
        {#if failed}<p class="ss-problems ss-wide" role="alert">{$t('frameleaf_studio_site_send_failed')}</p>{/if}
        <button type="submit" class="ss-cta ss-wide" disabled={sending || thumbnail} tabindex={tabIndex}
          >{$t('frameleaf_studio_site_send_inquiry')}</button
        >
      </form>
    {/if}
  </section>
{/snippet}

{#snippet clients()}
  <section class="ss-clients" id="ss-clients">
    <h2>{$t('frameleaf_studio_site_client_galleries')}</h2>
    <p>{$t('frameleaf_studio_site_client_galleries_body')}</p>
    {#if galleryAsked}
      <p role="status">{$t('frameleaf_studio_site_gallery_asked')}</p>
    {:else}
      <form onsubmit={askForGallery}>
        <input
          type="email"
          required
          maxlength="254"
          aria-label={$t('email')}
          placeholder="you@example.com"
          bind:value={galleryEmail}
          tabindex={tabIndex}
        />
        <button type="submit" disabled={sending || thumbnail} tabindex={tabIndex}
          >{$t('frameleaf_studio_site_find_gallery')}</button
        >
      </form>
    {/if}
  </section>
{/snippet}

<div
  class="ss"
  class:ss-thumbnail={thumbnail}
  data-template={site.template}
  data-dark={!brandColours && template.dark ? '' : undefined}
  {style}
  inert={thumbnail || undefined}
>
  <div class="ss-page">
    <header class="ss-header">
      <a class="ss-brand" href="#ss-top" tabindex={tabIndex}>
        {#if site.brand.logoUrl}<img src={site.brand.logoUrl} alt={site.brand.name} />{:else}{site.brand.name}{/if}
      </a>
      <nav aria-label={$t('frameleaf_studio_site_navigation')}>
        <a href="#ss-portfolio" tabindex={tabIndex}>{$t('frameleaf_studio_site_work')}</a>
        {#if has('about') && site.about}<a href="#ss-about" tabindex={tabIndex}>{$t('frameleaf_studio_site_about')}</a
          >{/if}
        {#if has('services') && site.packages.length > 0}<a href="#ss-services" tabindex={tabIndex}
            >{$t('frameleaf_studio_site_services')}</a
          >{/if}
        {#if has('inquiry')}<a href="#ss-inquiry" tabindex={tabIndex}>{$t('frameleaf_studio_site_contact')}</a>{/if}
        {#if has('clients')}<a class="ss-login" href="#ss-clients" tabindex={tabIndex}
            >{$t('frameleaf_studio_site_client_login')}</a
          >{/if}
      </nav>
    </header>
    {#each on as section (section.id)}
      {#if section.id === 'cover'}{@render coverSection()}
      {:else if section.id === 'portfolio'}{@render portfolio()}
      {:else if section.id === 'about'}{@render about()}
      {:else if section.id === 'services'}{@render services()}
      {:else if section.id === 'testimonials'}{@render testimonials()}
      {:else if section.id === 'faq'}{@render faq()}
      {:else if section.id === 'inquiry'}{@render inquirySection()}
      {:else if section.id === 'clients'}{@render clients()}
      {/if}
    {/each}
    <footer class="ss-footer">
      <span>© {new Date().getFullYear()} {site.brand.name}</span>
      {#if site.brand.email || site.brand.phone}<span
          >{[site.brand.email, site.brand.phone].filter(Boolean).join(' · ')}</span
        >{/if}
    </footer>
  </div>
</div>
