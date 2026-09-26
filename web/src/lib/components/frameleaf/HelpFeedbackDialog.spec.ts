import { render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('lists the configured help rows and third-party notices without naming the upstream project', () => {
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
    // FL-190: the upstream attribution is on the About screen only; this dialog names neither the
    // upstream project nor its sites, and offers no other project's community.
    expect(screen.queryByRole('heading', { name: /Built on/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Immich/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Discord/ })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/immich\.app|github\.com\/immich-app/);
    }
    expect(screen.getByText('Third-party notices')).toBeInTheDocument();
    expect(screen.getByText('Node.js')).toBeInTheDocument();
  });

  it('acknowledges Freecut with its full licence, loaded from the shipped file (owner decisions 2026-09-25)', async () => {
    render(HelpFeedbackDialog, {
      onClose: vi.fn(),
      info: { version: 'v3.2.0', versionUrl: '', licensed: false },
    });

    expect(screen.getByRole('link', { name: 'Freecut' })).toHaveAttribute(
      'href',
      'https://github.com/walterlow/freecut',
    );
    expect(screen.getByText(/Freecut, © its authors, used under the MIT licence/)).toBeInTheDocument();
    // The MIT text is the shipped studio/notices/freecut.txt, not a retyped copy.
    const shipped = readFileSync(path.resolve(process.cwd(), '../studio/notices/freecut.txt'), 'utf8');
    await waitFor(() => expect(screen.getByTestId('freecut-licence').textContent).toBe(shipped));
    expect(shipped).toMatch(/^MIT License\n\nCopyright \(c\) 2025 FreeCut/);
  });

  it('credits every model, voice, font and asset with its author and licence', () => {
    render(HelpFeedbackDialog, {
      onClose: vi.fn(),
      info: { version: 'v3.2.0', versionUrl: '', licensed: false },
    });

    const list = screen.getByTestId('acknowledgements');
    for (const name of [
      /InsightFace face detection/,
      /Parakeet TDT/,
      /Supertonic-3 text to speech/,
      /LFM2\.5-VL/,
      /MusicGen small/,
      /NLLB-CLIP/,
      /PP-OCRv5/,
    ]) {
      expect(within(list).getAllByText(name).length).toBeGreaterThan(0);
    }
    // The OpenRAIL-M use restrictions are passed on, and the non-commercial models say they stay local.
    expect(within(list).getByText(/Attachment A/)).toBeInTheDocument();
    expect(within(list).getAllByText(/Local use only: not offered on Frameleaf Cloud/)).toHaveLength(2);
    expect(within(list).getByText('121 font families')).toBeInTheDocument();
    expect(within(list).getByText(/Voices: af_heart/)).toBeInTheDocument();
  });
});
