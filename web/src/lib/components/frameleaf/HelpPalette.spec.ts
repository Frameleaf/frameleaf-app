import { HelpAnswerKind, type HelpArticleDto, type HelpIndexResponseDto } from '@frameleaf/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { resetHelpCache } from '$lib/frameleaf/help';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import HelpPalette from './HelpPalette.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/photos') } }));

const article = (id: string, title: string, patch: Partial<HelpArticleDto> = {}): HelpArticleDto => ({
  id,
  url: `/docs/${id}/`,
  section: id.split('/', 1)[0],
  sectionTitle: 'Using Frameleaf',
  title,
  description: `About ${title}`,
  appScreens: [],
  intro: '',
  headings: [],
  text: '',
  ...patch,
});

const index = (patch: Partial<HelpIndexResponseDto> = {}): HelpIndexResponseDto => ({
  origin: 'https://frameleaf.app',
  builtAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  offline: false,
  screens: ['photos'],
  screenGuides: { photos: ['using/library', 'using/editing'] },
  articles: [
    article('using/editing', 'Editing'),
    article('using/library', 'Library and timeline'),
    article('using/sharing', 'Sharing', {
      headings: [{ title: 'Shared albums', text: 'Share an album with people on your server.' }],
    }),
  ],
  ask: { enabled: true, hardware: 'NVIDIA GeForce RTX 3060 · 12 GB · CUDA · Frameleaf 1.1.7' },
  ...patch,
});

// The panel keeps what it read for the page load; each test starts as a fresh page would.
const open = async (value: HelpIndexResponseDto) => {
  resetHelpCache();
  sdkMock.getHelpIndex.mockResolvedValue(value);
  render(HelpPalette, { onClose: vi.fn() });
  await screen.findAllByText('Library and timeline');
};

describe(HelpPalette.name, () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
  });
  afterEach(() => {
    cleanup();
    authManager.reset();
  });

  it("lists the screen's guides in the website's order", async () => {
    await open(index());
    const rows = screen.getAllByRole('option').map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('Library and timeline');
    expect(rows[1]).toContain('Editing');
  });

  it('searches every guide and opens one in the reader', async () => {
    await open(index());
    sdkMock.getHelpArticle.mockResolvedValue({
      id: 'using/sharing',
      url: '/docs/using/sharing/',
      markdown:
        '# Sharing\n\nSource: https://frameleaf.app/docs/using/sharing/\n\nIntro text.\n\n## Shared albums\n\nPick people.',
    });
    const field = screen.getByRole('combobox');
    await fireEvent.input(field, { target: { value: 'shared albums' } });
    expect(screen.getByRole('option', { name: /Sharing › Shared albums/ })).toBeInTheDocument();
    await fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(sdkMock.getHelpArticle).toHaveBeenCalledWith({ section: 'using', slug: 'sharing' }));
    expect(await screen.findByText('Pick people.')).toBeInTheDocument();
  });

  it('asks Frameleaf with the screen and shows the cited sources', async () => {
    await open(index());
    sdkMock.askHelp.mockResolvedValue({
      kind: HelpAnswerKind.Answer,
      blocks: [{ text: 'Open the album and choose Share.', sourceIds: ['s1'] }],
      sources: [{ id: 's1', title: 'Sharing — Shared albums', url: '/docs/using/sharing/#shared-albums' }],
      questions: [],
    });
    await fireEvent.click(screen.getByRole('option', { name: 'frameleaf_help_panel_starter_share' }));
    await screen.findByText('Open the album and choose Share.');
    expect(sdkMock.askHelp).toHaveBeenCalledWith(
      { helpAskDto: { question: 'frameleaf_help_panel_starter_share', turns: [], screen: 'photos' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole('button', { name: /Sharing — Shared albums/ })).toBeInTheDocument();
    expect(screen.getByText(/RTX 3060/)).toBeInTheDocument();
  });

  it('says help is offline and keeps Ask out of reach', async () => {
    await open(index({ offline: true }));
    expect(screen.getByRole('status')).toHaveTextContent('frameleaf_help_panel_offline');
    expect(screen.queryByRole('option', { name: 'frameleaf_help_panel_starter_share' })).toBeNull();
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_help_panel_ask' }));
    expect(screen.getByText('frameleaf_help_panel_ask_offline')).toBeInTheDocument();
  });

  it('says when an administrator turned Ask off', async () => {
    await open(index({ ask: { enabled: false, hardware: null } }));
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_help_panel_ask' }));
    expect(screen.getByText('frameleaf_help_panel_ask_off')).toBeInTheDocument();
    expect(sdkMock.askHelp).not.toHaveBeenCalled();
  });
});
