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

  it('lists Frameleaf’s help in the approved order, with Discord, and names no upstream project', () => {
    render(HelpFeedbackDialog, {
      onClose: vi.fn(),
      info: { version: 'v3.2.0', versionUrl: '', licensed: false, nodejs: 'v24' },
    });

    const rows = screen.getAllByRole('link').filter((link) => link.classList.contains('help-link'));
    expect(rows.map((link) => [link.querySelector('strong')?.textContent, link.getAttribute('href')])).toEqual([
      ['Help Center', 'https://frameleaf.app/help/'],
      ['Documentation', 'https://frameleaf.app/docs/start/introduction/'],
      ['Get help on Discord', 'https://discord.gg/cN3U3mv4'],
      ['Community chat', 'https://frameleaf.app/help/community'],
      ['Report a problem', 'https://frameleaf.app/help/community/c/bug-reports'],
      ['Feature requests', 'https://frameleaf.app/help/community/c/ideas-feedback'],
      ['Source code', 'https://github.com/Frameleaf/frameleaf-app'],
    ]);
    // FL-190: the upstream attribution is on the About screen only; this dialog names neither the
    // upstream project nor its sites, and its Discord is Frameleaf's own.
    expect(screen.queryByText('Official Immich Resources')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Built on/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Immich/)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/immich\.app|github\.com\/immich-app|discord\.immich/);
    }
    expect(screen.getByText('Third-party notices')).toBeInTheDocument();
    expect(screen.getByText('Node.js')).toBeInTheDocument();
  });

  it('uses the addresses this installation is configured with in place of the defaults', () => {
    render(HelpFeedbackDialog, {
      onClose: vi.fn(),
      info: {
        version: 'v3.2.0',
        versionUrl: '',
        licensed: false,
        thirdPartyDocumentationUrl: 'https://docs.example.test',
        thirdPartySupportUrl: 'https://support.example.test',
        thirdPartyBugFeatureUrl: 'https://issues.example.test',
        thirdPartySourceUrl: 'https://source.example.test',
      },
    });

    expect(screen.getByRole('link', { name: /Documentation/ })).toHaveAttribute('href', 'https://docs.example.test');
    expect(screen.getByRole('link', { name: /Community chat/ })).toHaveAttribute(
      'href',
      'https://support.example.test',
    );
    // One configured tracker takes problems and requests alike.
    expect(screen.getByRole('link', { name: /Report a problem/ })).toHaveAttribute(
      'href',
      'https://issues.example.test',
    );
    expect(screen.getByRole('link', { name: /Feature requests/ })).toHaveAttribute(
      'href',
      'https://issues.example.test',
    );
    expect(screen.getByRole('link', { name: /Source code/ })).toHaveAttribute('href', 'https://source.example.test');
    // The Help Center and Discord are Frameleaf's own.
    expect(screen.getByRole('link', { name: /Help Center/ })).toHaveAttribute('href', 'https://frameleaf.app/help/');
    expect(screen.getByRole('link', { name: /Get help on Discord/ })).toHaveAttribute(
      'href',
      'https://discord.gg/cN3U3mv4',
    );
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
    // The OpenRAIL-M use restrictions are passed on, and the non-commercial models name their
    // personal-use basis: they run on Frameleaf Cloud too (FL-451).
    expect(within(list).getByText(/Attachment A/)).toBeInTheDocument();
    expect(within(list).getAllByText(/on this server, a home-network worker and Frameleaf Cloud/)).toHaveLength(3);
    expect(within(list).queryAllByText(/not offered on Frameleaf Cloud/)).toEqual([]);
    expect(within(list).getByText('121 font families')).toBeInTheDocument();
    expect(within(list).getByText(/Voices: af_heart/)).toBeInTheDocument();
  });
});
