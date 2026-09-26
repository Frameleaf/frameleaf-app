import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import FrameleafErrorPage from './FrameleafErrorPage.svelte';

beforeEach(() => {
  addMessages('dev', en);
});

describe('FrameleafErrorPage', () => {
  it('says what happened in words, with the ways on and the code small', async () => {
    const retry = vi.fn();
    render(FrameleafErrorPage, {
      title: en.frameleaf_spaces_viewer_unavailable_title,
      message: en.frameleaf_spaces_viewer_unavailable_body,
      code: 404,
      actions: [
        { label: en.frameleaf_spaces_viewer_back_to_sharing, href: '/sharing', primary: true },
        { label: en.frameleaf_error_go_photos, href: '/photos' },
        { label: en.frameleaf_error_retry, onclick: retry },
      ],
    });

    expect(screen.getByRole('heading', { level: 1, name: en.frameleaf_spaces_viewer_unavailable_title })).toBeVisible();
    expect(screen.getByText(en.frameleaf_spaces_viewer_unavailable_body)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.frameleaf_spaces_viewer_back_to_sharing })).toHaveAttribute(
      'href',
      '/sharing',
    );
    expect(screen.getByRole('link', { name: en.frameleaf_error_go_photos })).toHaveAttribute('href', '/photos');
    expect(screen.getByText('Error 404')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_error_retry }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('draws its own branded frame when it replaces the whole app', () => {
    const { container } = render(FrameleafErrorPage, {
      title: en.frameleaf_error_server_title,
      message: en.frameleaf_error_server_body,
      standalone: true,
    });

    expect(container.querySelector('main.frameleaf')).not.toBeNull();
    expect(screen.getByRole('link', { name: en.frameleaf_error_go_photos })).toHaveAttribute('href', '/photos');
    expect(container.textContent).not.toMatch(/immich|stack/i);
  });
});
