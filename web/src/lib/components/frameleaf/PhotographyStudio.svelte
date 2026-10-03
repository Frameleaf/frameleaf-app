<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
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
        error = 'This studio website is currently unavailable.';
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
      <nav aria-label="Studio website">
        <a href="#portfolio">Portfolio</a><a href="#about">About</a><a href="#contact">Contact</a>
      </nav>
    </header>
    <section class="pc-cover" data-treatment="quiet">
      <div class="pc-cover-copy">
        <span>{site.brand.tagline}</span>
        <h1>{site.title}</h1>
        <a href="#portfolio">View the portfolio ↓</a>
      </div>
    </section>
    <main class="pc-main">
      <section id="portfolio">
        <h2>Selected work</h2>
        {#if site.presentation.layout === 'slideshow'}{#if site.portfolio[slide]}{@const item =
              site.portfolio[slide]}<img
              class="pc-portfolio-slide"
              src={publicStudioMediaUrl(ownerId, `/photos/${item.shootId}/${item.captureId}`)}
              alt={`Portfolio photograph ${slide + 1}`}
            />
            <div class="pc-actions">
              <button type="button" disabled={slide === 0} onclick={() => slide--}>Previous</button><span
                >{slide + 1} / {site.portfolio.length}</span
              ><button type="button" disabled={slide === site.portfolio.length - 1} onclick={() => slide++}>Next</button
              >
            </div>{/if}{:else}<div class="pc-grid">
            {#each site.portfolio as item, index (`${item.shootId}:${item.captureId}`)}<article class="pc-photo">
                <img
                  class="pc-portfolio-photo"
                  src={publicStudioMediaUrl(ownerId, `/photos/${item.shootId}/${item.captureId}`)}
                  alt={`Portfolio photograph ${index + 1}`}
                  loading="lazy"
                />
              </article>{/each}
          </div>{/if}
      </section>
      <section class="pc-orders">
        <div id="about">
          <span class="pc-eyebrow">The studio</span>
          <h2>About {site.brand.name}</h2>
          <p class="pc-prose">{site.about}</p>
        </div>
        <div>
          <h2>Photography services</h2>
          <p class="pc-prose">{site.services}</p>
        </div>
      </section>
      <section id="contact" class="pc-contact">
        <h2>Let’s make something beautiful</h2>
        <p class="pc-prose">{site.contact}</p>
        <div class="pc-actions">
          {#if site.brand.email}<a href={`mailto:${site.brand.email}`}>{site.brand.email}</a
            >{/if}{#if site.brand.phone}<a href={`tel:${site.brand.phone}`}>{site.brand.phone}</a>{/if}
        </div>
      </section>
    </main>
    <footer class="pc-footer">{site.brand.name}</footer>
  </div>{:else}<main class="pc-access">
    <h1>{error || 'Opening the studio…'}</h1>
    {#if error}<button type="button" onclick={reload}>Try again</button>{/if}
  </main>{/if}
