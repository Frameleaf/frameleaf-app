import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import HelpFeedbackDialog from './HelpFeedbackDialog.svelte';

describe('HelpFeedbackDialog (S-3)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
  });

  it('lists the configured help rows, the Immich attribution and third-party notices', () => {
    render(HelpFeedbackDialog, {
      onClose: vi.fn(),
      info: {
        version: 'v3.2.0',
        versionUrl: '',
        licensed: false,
        nodejs: 'v24',
        thirdPartyDocumentationUrl: 'https://docs.example.test',
        thirdPartyBugFeatureUrl: 'https://issues.example.test',
      },
    });

    expect(screen.queryByText('Official Immich Resources')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Report a problem/ })).toHaveAttribute(
      'href',
      'https://issues.example.test',
    );
    expect(screen.getByRole('link', { name: /Feature requests/ })).toHaveAttribute(
      'href',
      'https://issues.example.test',
    );
    // Without a configured community address that row is left out.
    expect(screen.queryByRole('link', { name: /Community chat/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Built on Immich' })).toBeInTheDocument();
    // FL-135: attribution links only; the Immich community is not offered as help with Frameleaf.
    expect(screen.queryByRole('link', { name: /Discord/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Source/ })).toHaveAttribute(
      'href',
      'https://github.com/immich-app/immich/',
    );
    expect(screen.getByText('Third-party notices')).toBeInTheDocument();
    expect(screen.getByText('AGPL-3.0')).toBeInTheDocument();
  });

  it('acknowledges Freecut, the Studio editor, at its pinned revision (owner decision 2026-09-25)', () => {
    render(HelpFeedbackDialog, {
      onClose: vi.fn(),
      info: { version: 'v3.2.0', versionUrl: '', licensed: false },
    });

    expect(screen.getByRole('link', { name: 'Freecut' })).toHaveAttribute(
      'href',
      'https://github.com/walterlow/freecut',
    );
    expect(screen.getByText('Studio video editor')).toBeInTheDocument();
    expect(screen.getByText('MIT')).toBeInTheDocument();
    expect(screen.getByText(/Freecut, © its authors, used under the MIT licence/)).toBeInTheDocument();
  });
});
