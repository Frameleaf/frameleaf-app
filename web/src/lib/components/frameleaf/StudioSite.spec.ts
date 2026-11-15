import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import type { PublicSite } from '$lib/frameleaf/photography/workflow-api';
import StudioSite from './StudioSite.svelte';

const photo = (key: string, alt: string) => ({
  key,
  alt,
  width: 2048,
  height: 1365,
  url: `/api/photography/studios/o/photos/${key}/2048?v=1`,
  srcset: `/api/photography/studios/o/photos/${key}/640?v=1 640w`,
});

const site = (patch: Partial<PublicSite> = {}): PublicSite => ({
  ownerId: 'o',
  template: 'editorial',
  colours: 'template',
  coverFocal: 30,
  sections: (['cover', 'portfolio', 'about', 'services', 'testimonials', 'faq', 'inquiry', 'clients'] as const).map(
    (id) => ({ id, on: id !== 'faq' }),
  ),
  title: 'Cedar & Light',
  about: 'Portraits in the Rockies.',
  contact: 'Tell me about your plans.',
  packages: [{ name: 'Portrait session', price: 'From $450', detail: 'One hour.' }],
  testimonials: [{ quote: 'We forgot the camera was there.', name: 'Jamie' }],
  faq: [{ q: 'Do you travel?', a: 'Yes.' }],
  trustedBy: ['Northbound Journal'],
  booking: true,
  bookingAfter: 'services',
  cover: photo('s:a', 'Jamie by the lake'),
  collections: [
    { id: 'weddings', name: 'Weddings', photos: [photo('s:a', 'Jamie by the lake'), photo('s:b', 'First dance')] },
    { id: 'families', name: 'Families', photos: [photo('s:c', 'A walk together')] },
    { id: 'empty', name: 'Empty', photos: [] },
  ],
  brand: {
    name: 'Cedar & Light',
    tagline: 'People, places, and the light between.',
    email: 'hello@cedar.example',
    phone: '',
    color: '#577059',
    background: '#f5f3ed',
    textColor: '#263329',
    font: 'editorial',
    logoUrl: null,
  },
  ...patch,
});

describe('StudioSite (FL-702)', () => {
  beforeAll(() => addMessages('dev', en));

  it('shows the turned-on sections with sized, described photographs and switches collections', async () => {
    render(StudioSite, { site: site() });
    expect(screen.getByRole('heading', { level: 1, name: 'People, places, and the light between.' })).toBeVisible();
    expect(screen.queryByText('Do you travel?')).not.toBeInTheDocument();
    expect(screen.getByText('Portrait session')).toBeInTheDocument();
    const dance = screen.getByAltText('First dance');
    expect(dance).toHaveAttribute('srcset', expect.stringContaining('640w'));
    expect(dance).toHaveAttribute('width', '2048');
    // a collection with no photographs is not offered
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual(['Weddings', 'Families']);
    await fireEvent.click(screen.getByRole('tab', { name: 'Families' }));
    expect(screen.getByAltText('A walk together')).toBeInTheDocument();
    expect(screen.queryByAltText('First dance')).not.toBeInTheDocument();
  });

  it('shows a Booking card for each session right after Services, each opening the form on it (FL-1606)', async () => {
    const onBook = vi.fn();
    const bookings = [
      {
        id: 't1',
        name: 'Family session',
        description: '',
        durationMinutes: 60,
        price: 30_000,
        deposit: 5000,
        currency: 'CAD',
        addOns: [],
      },
      {
        id: 't2',
        name: 'Mini session',
        description: '',
        durationMinutes: 20,
        price: 12_000,
        deposit: 0,
        currency: 'CAD',
        addOns: [],
      },
    ];
    for (const template of ['editorial', 'minimal', 'gallery', 'cinematic', 'noir', 'commercial'] as const) {
      const view = render(StudioSite, { site: site({ template }), bookings, onBook });
      const section = document.querySelector('#ss-booking')!;
      expect(section.previousElementSibling).toHaveClass('ss-services');
      expect(screen.getByText(/60 minutes · .*50\.00 deposit to book/)).toBeInTheDocument();
      expect(screen.getByText('20 minutes')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Book' })).toHaveAttribute('href', '#ss-booking');
      // The section replaces the header's "Book a session" button.
      expect(screen.queryByRole('button', { name: 'Book a session' })).not.toBeInTheDocument();
      view.unmount();
    }
    // Moved in the editor: it follows the section it names.
    const moved = render(StudioSite, { site: site({ bookingAfter: 'portfolio' }), bookings, onBook });
    expect(document.querySelector('#ss-booking')!.previousElementSibling).toHaveClass('ss-portfolio');
    moved.unmount();
    render(StudioSite, { site: site(), bookings, onBook });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Book' })[1]);
    expect(onBook).toHaveBeenCalledWith('t2');
  });

  it('keeps only the header booking button when the Booking section is off', () => {
    render(StudioSite, {
      site: site({ booking: false }),
      bookings: [
        {
          id: 't1',
          name: 'Family',
          description: '',
          durationMinutes: 60,
          price: 1,
          deposit: 0,
          currency: 'CAD',
          addOns: [],
        },
      ],
      onBook: vi.fn(),
    });
    expect(document.querySelector('#ss-booking')).toBeNull();
    expect(screen.getByRole('button', { name: 'Book a session' })).toBeInTheDocument();
  });

  it('shows the Commercial client list only on that template', () => {
    const view = render(StudioSite, { site: site() });
    expect(screen.queryByText('Northbound Journal')).not.toBeInTheDocument();
    view.unmount();
    render(StudioSite, { site: site({ template: 'commercial' }) });
    expect(screen.getByText('Northbound Journal')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Start a project' }).length).toBeGreaterThan(0);
  });

  it('checks the inquiry before sending it, then thanks the visitor', async () => {
    const onInquiry = vi.fn(() => Promise.resolve());
    render(StudioSite, { site: site(), onInquiry });
    await fireEvent.click(screen.getByRole('button', { name: 'Send inquiry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add your name.');
    expect(onInquiry).not.toHaveBeenCalled();

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Sam Rivera' } });
    await fireEvent.input(screen.getAllByLabelText('Email')[0], { target: { value: 'sam@example.com' } });
    await fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'June in Banff?' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send inquiry' }));
    expect(onInquiry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inquiry', name: 'Sam Rivera', email: 'sam@example.com', website: undefined }),
    );
    expect(await screen.findByText('Thank you, Sam.')).toBeInTheDocument();
  });

  it('answers a gallery-link request the same way whatever the server says', async () => {
    const onInquiry = vi.fn(() => Promise.reject(new Error('rate limited')));
    render(StudioSite, { site: site(), onInquiry });
    await fireEvent.input(screen.getByPlaceholderText('you@example.com'), { target: { value: 'x@example.com' } });
    await fireEvent.submit(screen.getByRole('button', { name: 'Send me my link' }).closest('form')!);
    expect(await screen.findByText(en.frameleaf_studio_site_gallery_asked)).toBeInTheDocument();
    expect(onInquiry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gallery-link', email: 'x@example.com' }));
  });

  it('sends nothing from the editor preview', async () => {
    render(StudioSite, { site: site() });
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Sam' } });
    await fireEvent.input(screen.getAllByLabelText('Email')[0], { target: { value: 'sam@example.com' } });
    await fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'Hi' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send inquiry' }));
    expect(await screen.findByText(en.frameleaf_studio_site_preview_not_sent)).toBeInTheDocument();
  });
});
