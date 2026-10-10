<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { publicStudio, publicStudioMediaUrl, type PublicSite } from '$lib/frameleaf/photography/workflow-api';
  import '$lib/frameleaf/photography/gallery.css';
  let { ownerId }: { ownerId: string } = $props();
  let site = $state<PublicSite | null>(null);
  let error = $state('');
  let slide = $state(0);
  let disposed = false;
  async function reload() {
    error = '';
    try {
      const result = await publicStudio(ownerId);
      if (!disposed) {
        site = result;
      }
    } catch {
      if (!disposed) {
        site = null;
        error = $t('frameleaf_photography_public_unavailable');
      }
    }
  }
  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

{#if site}<div
    class="pc pc-website"
    data-template={site.presentation.layout === 'editorial' ? 'wedding' : 'fine-art'}
    data-spacing={site.presentation.spacing}
    data-font={site.presentation.font}
    data-palette={site.presentation.palette}
    style={`--pc-accent:${site.brand.color};--pc-studio-bg:${site.brand.background};--pc-studio-text:${site.brand.textColor}`}
  >
    <header class="pc-header">
      <a href="#portfolio" class="pc-studio"
        >{#if site.brand.logoUrl}<img src={publicStudioMediaUrl(ownerId, '/logo')} alt="" />{/if}{site.brand.name}</a
      >
      <nav aria-label={$t('frameleaf_photography_studio_website')}>
        <a href="#portfolio">{$t('frameleaf_photography_public_portfolio')}</a><a href="#about"
          >{$t('frameleaf_photography_site_about')}</a
        ><a href="#contact">{$t('frameleaf_photography_public_contact')}</a>
      </nav>
    </header>
    <section class="pc-cover" data-treatment="quiet">
      <div class="pc-cover-copy">
        <span>{site.brand.tagline}</span>
        <h1>{site.title}</h1>
        <a href="#portfolio">{$t('frameleaf_photography_public_view_portfolio')} ↓</a>
      </div>
    </section>
    <main class="pc-main">
      <section id="portfolio">
        <h2>{$t('frameleaf_photography_public_selected_work')}</h2>
        {#if site.presentation.layout === 'slideshow'}{#if site.portfolio[slide]}{@const item =
              site.portfolio[slide]}<img
              class="pc-portfolio-slide"
              src={publicStudioMediaUrl(ownerId, `/photos/${item.shootId}/${item.captureId}`)}
              alt={$t('frameleaf_photography_public_photo_alt', { values: { number: slide + 1 } })}
            />
            <div class="pc-actions">
              <button type="button" disabled={slide === 0} onclick={() => slide--}
                >{$t('frameleaf_photography_client_previous')}</button
              ><span>{slide + 1} / {site.portfolio.length}</span><button
                type="button"
                disabled={slide === site.portfolio.length - 1}
                onclick={() => slide++}>{$t('frameleaf_photography_client_next')}</button
              >
            </div>{/if}{:else}<div class="pc-grid">
            {#each site.portfolio as item, index (`${item.shootId}:${item.captureId}`)}<article class="pc-photo">
                <img
                  class="pc-portfolio-photo"
                  src={publicStudioMediaUrl(ownerId, `/photos/${item.shootId}/${item.captureId}`)}
                  alt={$t('frameleaf_photography_public_photo_alt', { values: { number: index + 1 } })}
                  loading="lazy"
                />
              </article>{/each}
          </div>{/if}
      </section>
      <section class="pc-orders">
        <div id="about">
          <span class="pc-eyebrow">{$t('frameleaf_photography_public_the_studio')}</span>
          <h2>{$t('frameleaf_photography_public_about', { values: { name: site.brand.name } })}</h2>
          <p class="pc-prose">{site.about}</p>
        </div>
        <div>
          <h2>{$t('frameleaf_photography_public_services')}</h2>
          <p class="pc-prose">{site.services}</p>
        </div>
      </section>
      <section id="contact" class="pc-contact">
        <h2>{$t('frameleaf_photography_public_contact_title')}</h2>
        <p class="pc-prose">{site.contact}</p>
        <div class="pc-actions">
          {#if site.brand.email}<a href={`mailto:${site.brand.email}`}>{site.brand.email}</a
            >{/if}{#if site.brand.phone}<a href={`tel:${site.brand.phone}`}>{site.brand.phone}</a>{/if}
        </div>
      </section>
    </main>
    <footer class="pc-footer">{site.brand.name}</footer>
  </div>{:else}<main class="pc-access">
    <h1>{error || $t('frameleaf_photography_public_opening')}</h1>
    {#if error}<button type="button" onclick={reload}>{$t('frameleaf_error_retry')}</button>{/if}
  </main>{/if}
