import { ApiService, render } from 'src/services/api.service.js';

describe(ApiService.name, () => {
  describe('render', () => {
    it('should correctly render open graph tags', () => {
      const output = render('<!-- metadata:tags -->', {
        title: 'title',
        description: 'description',
        imageUrl: 'https://demo.immich.app/api/assets/123',
      });
      expect(output).toContain('<meta property="og:title" content="title" />');
      expect(output).toContain('<meta property="og:description" content="description" />');
      expect(output).toContain('<meta property="og:image" content="https://demo.immich.app/api/assets/123" />');
    });

    it('should escape html tags', () => {
      expect(
        render('<!-- metadata:tags -->', {
          title: "<script>console.log('hello')</script>Test",
          description: 'description',
        }),
      ).toContain(
        '<meta property="og:title" content="&lt;script&gt;console.log(&#39;hello&#39;)&lt;/script&gt;Test" />',
      );
    });

    it('should escape quotes', () => {
      expect(
        render('<!-- metadata:tags -->', {
          title: `0;url=https://example.com" http-equiv="refresh`,
          description: 'description',
        }),
      ).toContain('<meta property="og:title" content="0;url=https://example.com&quot; http-equiv=&quot;refresh" />');
    });
  });

  describe('ssr', () => {
    const serve = async (url: string) => {
      const config = { getEnv: () => ({ resourcePaths: { web: { indexHtml: '/nonexistent/index.html' } } }) };
      const logger = { setContext: vi.fn(), warn: vi.fn() };
      const service = new ApiService({} as never, {} as never, config as never, logger as never);
      const headers: Record<string, string> = {};
      const res = {
        status: () => res,
        type: () => res,
        header: (name: string, value: string) => {
          headers[name] = value;
          return res;
        },
        send: vi.fn(),
      };
      const request = {
        method: 'GET',
        url,
        path: url.split('?', 1)[0],
        accepts: () => 'text/html',
        header: () => {},
        protocol: 'https',
        host: 'photos.example',
      };
      await service.ssr([])(request as never, res as never, vi.fn());
      return headers;
    };

    it('sends /link with no referrer, so nothing in its address leaves in a Referer (CLD-004)', async () => {
      expect((await serve('/link?target=frameleaf_license&linkCode=flc_x'))['Referrer-Policy']).toBe('no-referrer');
      expect((await serve('/photos'))['Referrer-Policy']).toBeUndefined();
    });
  });
});
