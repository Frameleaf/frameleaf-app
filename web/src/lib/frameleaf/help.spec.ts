// @vitest-environment jsdom
// DOMPurify needs a DOM that parses and walks like a browser's; happy-dom drops nodes mid-walk.
import type { HelpArticleDto, HelpIndexResponseDto } from '@frameleaf/sdk';
import {
  headingAnchor,
  helpArticleUrl,
  helpScreenFor,
  renderHelpArticle,
  screenArticles,
  screenNameKey,
  searchHelp,
} from '$lib/frameleaf/help';

const article = (id: string, patch: Partial<HelpArticleDto> = {}): HelpArticleDto => ({
  id,
  url: `/docs/${id}/`,
  section: id.split('/', 1)[0],
  sectionTitle: 'Using Frameleaf',
  title: id,
  description: '',
  appScreens: [],
  intro: '',
  headings: [],
  text: '',
  ...patch,
});

const articles = [
  article('using/albums', { title: 'Albums and shared spaces', description: 'Organise photos into albums' }),
  article('using/sharing', {
    title: 'Sharing',
    description: 'Share with family, partners and anyone with a link',
    headings: [{ title: 'Shared albums', text: 'Share an album with people on your server.' }],
  }),
  article('admin/video-transcoding', { title: 'Video transcoding', text: 'Playback copies of your videos' }),
];

describe('helpScreenFor', () => {
  it.each([
    ['/photos', 'photos'],
    ['/photos/0d2c', 'photos'],
    ['/favorites', 'photos'],
    ['/albums/abc', 'albums'],
    ['/memory/1', 'memories'],
    ['/user-settings?area=processing', 'settings:processing'],
    ['/admin/jobs-status', 'settings:processing'],
    ['/admin/somewhere-new', 'settings:overview'],
    ['/studio/projects', 'studio'],
  ])('%s is %s', (path, key) => {
    expect(helpScreenFor(new URL(path, 'https://frameleaf.local'), true)).toBe(key);
  });

  it('opens Settings on the area a person would land on', () => {
    expect(helpScreenFor(new URL('/user-settings', 'https://frameleaf.local'), false)).toBe('settings:preferences');
  });
});

describe('screenNameKey', () => {
  it('names pages and Settings areas', () => {
    expect(screenNameKey('photos')).toBe('library');
    expect(screenNameKey('settings:processing')).toBe('frameleaf_settings_area_processing');
    expect(screenNameKey('somewhere')).toBe('frameleaf_help_panel_general');
  });
});

describe('screenArticles', () => {
  const index = {
    articles,
    screenGuides: { sharing: ['using/sharing', 'using/albums', 'using/gone'] },
  } as unknown as HelpIndexResponseDto;

  it("keeps the screen's order and skips guides that are not in the index", () => {
    expect(screenArticles(index, 'sharing').map((item) => item.id)).toEqual(['using/sharing', 'using/albums']);
  });

  it('falls back to general help for a screen without guides', () => {
    expect(screenArticles({ ...index, articles: [article('help/faq')] }, 'nowhere').map((item) => item.id)).toEqual([
      'help/faq',
    ]);
  });
});

describe('searchHelp', () => {
  it('weighs titles and sections over text, and names the matching section', () => {
    const [first, second] = searchHelp(articles, 'share album');
    expect(first.article.id).toBe('using/sharing');
    expect(first.heading?.title).toBe('Shared albums');
    expect(second.article.id).toBe('using/albums');
    expect(searchHelp(articles, 'albums')[0].article.id).toBe('using/albums');
  });

  it('puts the guide with a section named by every word first', () => {
    const [first] = searchHelp(
      [
        article('using/albums', { title: 'Albums and shared spaces', text: 'Share links to albums' }),
        article('using/sharing', { title: 'Sharing', headings: [{ title: 'Shared links', text: '' }] }),
      ],
      'shared links',
    );
    expect(first.article.id).toBe('using/sharing');
    expect(first.heading?.title).toBe('Shared links');
  });

  it('needs every word, ignores filler words and matches word starts', () => {
    expect(searchHelp(articles, 'How do I transcod my videos?').map((hit) => hit.article.id)).toEqual([
      'admin/video-transcoding',
    ]);
    expect(searchHelp(articles, 'albums zebra')).toEqual([]);
    expect(searchHelp(articles, '  ')).toEqual([]);
  });
});

describe('links', () => {
  it('makes the anchors the website makes', () => {
    expect(headingAnchor("What's never shared")).toBe('whats-never-shared');
    expect(headingAnchor('Choose where each kind of work runs')).toBe('choose-where-each-kind-of-work-runs');
    expect(helpArticleUrl('https://frameleaf.app', articles[1], 'Shared albums')).toBe(
      'https://frameleaf.app/docs/using/sharing/#shared-albums',
    );
  });
});

describe('renderHelpArticle', () => {
  const ids = new Set(['using/sharing', 'admin/jobs']);
  const render = (markdown: string) => {
    const html = renderHelpArticle(markdown, 'https://frameleaf.app', ids);
    const element = document.createElement('div');
    element.innerHTML = html;
    return element;
  };

  it('drops the title and source line and keeps headings linkable', () => {
    const element = render(
      '# Sharing\n\nSource: https://frameleaf.app/docs/using/sharing/\n\nIntro.\n\n## Shared albums\n\nText.',
    );
    expect(element.querySelector('h1')).toBeNull();
    expect(element.textContent).not.toContain('Source:');
    expect(element.querySelector('h2')?.id).toBe('shared-albums');
  });

  it('opens other guides in the reader and everything else in a new tab', () => {
    const element = render(
      '[Jobs](https://frameleaf.app/docs/admin/jobs/#the-queues) [Spaces](#shared-spaces) [Other](https://frameleaf.app/docs/unknown/page/) [Tailscale](https://tailscale.com)',
    );
    const [jobs, spaces, other, tailscale] = element.querySelectorAll('a');
    expect(jobs.dataset).toMatchObject({ helpArticle: 'admin/jobs', helpHeading: 'the-queues' });
    expect(spaces.dataset.helpHeading).toBe('shared-spaces');
    expect(spaces.dataset.helpArticle).toBeUndefined();
    expect(other.getAttribute('target')).toBe('_blank');
    expect(tailscale.getAttribute('href')).toBe('https://tailscale.com/');
    expect(tailscale.getAttribute('rel')).toBe('noreferrer');
  });

  it('turns asides into asides and never lets markup through', () => {
    const element = render(
      ':::caution[Nothing falls back silently]\nA job is **refused**.\n:::\n\n<script>alert(1)</script><img src="/shots/a.jpg" onerror="alert(1)"><img src="javascript:alert(1)">\n\n[x](javascript:alert(1))',
    );
    const aside = element.querySelector('aside');
    expect(aside?.dataset.kind).toBe('caution');
    expect(aside?.querySelector('strong')?.textContent).toBe('Nothing falls back silently');
    expect(aside?.textContent).toContain('A job is refused.');
    expect(element.textContent).not.toContain('[!');
    expect(element.querySelector('script')).toBeNull();
    expect(element.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect([...element.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      'https://frameleaf.app/shots/a.jpg',
    ]);
    // eslint-disable-next-line unicorn/prefer-dom-node-html-methods -- getHTML is missing from jsdom
    expect(element.innerHTML).not.toContain('javascript:');
  });
});
