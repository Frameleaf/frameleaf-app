/* Native media-frame extension shared by Classic Editor and Gutenberg MediaUpload. */
(() => {
  const text = frameleafMedia;
  const api = (path, options = {}) => wp.apiFetch({ path: `/frameleaf-connect/v1/${path}`, ...options });
  const element = (tag, content, attrs = {}) => {
    const node = document.createElement(tag);
    if (content) node.textContent = content;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const Browser = wp.media.View.extend({
    className: 'frameleaf-media',
    initialize() { this.page = 1; this.generation = 0; this.disposed = false; },
    render() {
      this.el.replaceChildren();
      const form = element('form', '', { class: 'frameleaf-toolbar' });
      this.album = element('select', '', { 'aria-label': text.albums });
      this.album.append(element('option', text.albums, { value: '' }));
      this.query = element('input', '', { type: 'search', 'aria-label': text.search, placeholder: text.search, maxlength: '200' });
      form.append(this.album, this.query, element('button', text.search, { type: 'submit', class: 'button' }), element('a', text.connect, { href: text.settings, target: '_blank', rel: 'noopener' }));
      form.addEventListener('submit', (event) => { event.preventDefault(); this.page = 1; this.load(); });
      this.album.addEventListener('change', () => { this.page = 1; this.load(); });
      const acknowledgement = element('label', '', { class: 'frameleaf-acknowledgement' });
      this.acknowledged = element('input', '', { type: 'checkbox' });
      acknowledgement.append(this.acknowledged, document.createTextNode(` ${text.confirm}`));
      this.status = element('p', '', { role: 'status', 'aria-live': 'polite' });
      this.grid = element('div', '', { class: 'frameleaf-grid' });
      this.previous = element('button', text.previous, { type: 'button', class: 'button' });
      this.next = element('button', text.next, { type: 'button', class: 'button' });
      this.previous.addEventListener('click', () => { this.page--; this.load(); });
      this.next.addEventListener('click', () => { this.page++; this.load(); });
      const pages = element('div', '', { class: 'frameleaf-pagination' }); pages.append(this.previous, this.next);
      this.el.append(form, element('p', text.copy), acknowledgement, this.status, this.grid, pages);
      api('albums').then(({ items }) => { if (!this.disposed) for (const album of items) this.album.append(element('option', album.name, { value: album.id })); }).catch(() => { this.status.textContent = text.failed; });
      this.load();
      return this;
    },
    async load() {
      const generation = ++this.generation;
      this.observer?.disconnect();
      this.status.textContent = text.loading;
      this.grid.replaceChildren();
      this.previous.disabled = this.next.disabled = true;
      try {
        const params = new URLSearchParams({ q: this.query.value, album: this.album.value, page: String(this.page) });
        const result = await api(`assets?${params}`);
        if (this.disposed || generation !== this.generation) return;
        this.status.textContent = result.items.length ? '' : text.empty;
        this.previous.disabled = this.page <= 1;
        this.next.disabled = this.page * result.size >= result.total;
        this.observer = new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.isIntersecting) {
            this.observer.unobserve(entry.target);
            api(`preview?id=${encodeURIComponent(entry.target.dataset.asset)}`).then(({ data }) => {
              if (!this.disposed && generation === this.generation && /^data:image\/(jpeg|png|webp);base64,/.test(data)) entry.target.src = data;
            }).catch(() => { if (!this.disposed) this.status.textContent = text.failed; });
          }
        }, { root: this.el, rootMargin: '100px' });
        for (const asset of result.items) {
          const card = element('div', '', { class: 'frameleaf-card' });
          const preview = element('img', '', { alt: asset.title || text.image, width: '160', height: '120' });
          preview.dataset.asset = asset.id;
          const button = element('button', text.import, { type: 'button', class: 'button', 'aria-label': `${text.import}: ${asset.title || text.image}` });
          button.addEventListener('click', async () => {
            if (!this.acknowledged.checked) { this.acknowledged.focus(); this.status.textContent = text.confirm; return; }
            button.disabled = true;
            this.status.textContent = text.loading;
            try {
              const copy = await api('import', { method: 'POST', data: { id: asset.id, copyAcknowledged: true } });
              if (this.disposed) return;
              const attachment = wp.media.attachment(copy.id).set(copy);
              const state = this.controller.state();
              state.get('library')?.add(attachment);
              state.get('selection').add(attachment);
              this.controller.content.mode('browse');
            } catch { if (!this.disposed) { this.status.textContent = text.failed; button.disabled = false; } }
          });
          card.append(preview, element('p', asset.title || text.image), button);
          this.grid.append(card);
          this.observer.observe(preview);
        }
      } catch { if (!this.disposed && generation === this.generation) this.status.textContent = text.failed; }
    },
    dispose() { this.disposed = true; this.generation++; this.observer?.disconnect(); return wp.media.View.prototype.dispose.apply(this, arguments); },
  });
  const original = wp.media.view.MediaFrame.Select.prototype.bindHandlers;
  wp.media.view.MediaFrame.Select.prototype.bindHandlers = function () {
    original.apply(this, arguments);
    this.on('router:render:browse', (router) => router.set({ frameleaf: { text: text.title, priority: 60 } }));
    this.on('content:create:frameleaf', (region) => { region.view = new Browser({ controller: this }); });
  };
})();
