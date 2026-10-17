// @vitest-environment jsdom
// DOMPurify needs a DOM that parses and walks like a browser's; happy-dom drops nodes mid-walk.
import { render } from '@testing-library/svelte';
import WelcomeMessage from '$lib/components/frameleaf/WelcomeMessage.svelte';
import { cleanWelcomeHtml } from '$lib/frameleaf/welcome-message';

describe('the welcome message before sign-in (FL-426)', () => {
  it('keeps text, emphasis, lists and links', () => {
    const html = cleanWelcomeHtml(
      '<p>Hello, <b>family</b> and <em>friends</em>.</p><ul><li>One</li></ul><a href="https://example.com/help">Help</a>',
    );
    expect(html).toContain('<b>family</b>');
    expect(html).toContain('<em>friends</em>');
    expect(html).toContain('<ul><li>One</li></ul>');
    expect(html).toContain('href="https://example.com/help"');
  });

  it('leaves out scripts, event handlers, styles and anything loaded from elsewhere', () => {
    const html = cleanWelcomeHtml(
      [
        '<script>alert(1)</script>',
        '<img src="https://tracker.example/pixel.png">',
        '<iframe src="https://example.com"></iframe>',
        '<video src="https://example.com/v.mp4"></video>',
        '<object data="https://example.com/x"></object>',
        '<svg><circle onload="alert(2)"></circle></svg>',
        '<style>body{background:url(https://tracker.example/bg.png)}</style>',
        '<p style="background:url(https://tracker.example/bg.png)" onclick="alert(3)" class="x">Kept</p>',
      ].join(''),
    );
    expect(html).toBe('<p>Kept</p>');
  });

  it('keeps only links to web pages, an email address or this server, opening in a new tab', () => {
    const link = (href: string) => cleanWelcomeHtml(`<a href="${href}">Go</a>`);
    expect(link('javascript:alert(1)')).toBe('<a>Go</a>');
    expect(link('data:text/html,hi')).toBe('<a>Go</a>');
    expect(link('//elsewhere.example/x')).toBe('<a>Go</a>');
    expect(link('mailto:help@example.com')).toContain('href="mailto:help@example.com"');
    expect(link('/photos')).toContain('href="/photos"');
    const kept = link('https://example.com');
    expect(kept).toContain('target="_blank"');
    expect(kept).toContain('rel="noopener noreferrer"');
    // a link's own target is never taken from the message
    expect(cleanWelcomeHtml('<a href="https://example.com" target="_top" rel="opener">Go</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Go</a>',
    );
  });

  it('draws plain text as typed, line breaks kept, and formatted text cleaned', () => {
    const typed = 'Hello,\n<b>family</b>';
    const plain = render(WelcomeMessage, { message: typed, format: 'plain' });
    expect(plain.container.querySelector('.welcome-message')?.textContent).toBe(typed);
    expect(plain.container.querySelector('b')).toBeNull();
    plain.unmount();

    const formatted = render(WelcomeMessage, {
      message: '<b>family</b><img src=x onerror="alert(1)">',
      format: 'html',
    });
    expect(formatted.container.querySelector('b')).toHaveTextContent('family');
    expect(formatted.container.querySelector('img')).toBeNull();
  });
});
