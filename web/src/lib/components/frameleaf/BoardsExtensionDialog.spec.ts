import { render, screen } from '@testing-library/svelte';
import BoardsExtensionDialog from '$lib/components/frameleaf/BoardsExtensionDialog.svelte';

describe('Get the extension (FL-655)', () => {
  it('adds the extension, signs in with your Frameleaf account, then starts saving', () => {
    render(BoardsExtensionDialog, { open: true });

    expect(screen.getAllByRole('listitem').map((step) => step.querySelector('strong')?.textContent)).toEqual([
      'frameleaf_boards_extension_step_add',
      'frameleaf_boards_extension_step_sign_in',
      'frameleaf_boards_extension_step_start',
    ]);
    // a key is only the fallback, in API keys
    expect(screen.getByRole('link', { name: 'frameleaf_boards_extension_use_key' })).toHaveAttribute(
      'href',
      expect.stringContaining('section=api-keys'),
    );
  });
});
