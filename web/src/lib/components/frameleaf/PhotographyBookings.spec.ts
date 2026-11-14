import { toastManager } from '@frameleaf/ui';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PhotographyBookings from './PhotographyBookings.svelte';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  },
}));

const booking = (id: string, patch: object = {}) => ({
  id,
  bookingTypeId: null,
  typeName: 'Family session',
  clientName: 'Morgan Ellis',
  clientEmail: 'morgan@example.test',
  message: 'Two kids and a dog',
  preferredDates: ['2027-06-01'],
  addOns: [{ id: 'prints', name: 'Prints', price: 2500, quantity: 2 }],
  total: 35_000,
  deposit: 5000,
  currency: 'CAD',
  depositStatus: 'paid' as const,
  status: 'requested' as const,
  requestedAt: '2027-05-01T10:00:00.000Z',
  ...patch,
});

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  handlers.clear();
  vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
});

describe('PhotographyBookings (FL-1606)', () => {
  it('lists waiting requests first and filters by status', async () => {
    sdkMock.photographyBookings.mockResolvedValue({
      mailReady: true,
      bookings: [booking('b1'), booking('b2', { clientName: 'Sam Okafor', status: 'confirmed' })],
    });
    render(PhotographyBookings);
    expect(await screen.findByText('Morgan Ellis')).toBeInTheDocument();
    expect(screen.queryByText('Sam Okafor')).not.toBeInTheDocument();
    expect(screen.getByText('Deposit paid')).toBeInTheDocument();
    expect(screen.getByText(/^Family session · Tue, Jun 1$/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('confirms a request and emails the client when asked', async () => {
    sdkMock.photographyBookings.mockResolvedValue({ mailReady: true, bookings: [booking('b1')] });
    sdkMock.photographyUpdateBookingStatus.mockResolvedValue({
      ...booking('b1', { status: 'confirmed' }),
      clientEmailed: true,
    });
    render(PhotographyBookings);
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByText('Two kids and a dog')).toBeInTheDocument();
    expect(screen.getByLabelText('Email Morgan when I confirm or decline')).toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() =>
      expect(sdkMock.photographyUpdateBookingStatus).toHaveBeenCalledWith({
        id: 'b1',
        photographyBookingStatusDto: { status: 'confirmed', notifyClient: true },
      }),
    );
    expect(toastManager.primary).toHaveBeenCalledWith('Confirmed Morgan Ellis’s booking. We emailed them.');
  });

  it('asks before declining, warns that a paid deposit isn’t refunded, and offers no email when mail is off', async () => {
    sdkMock.photographyBookings.mockResolvedValue({ mailReady: false, bookings: [booking('b1')] });
    sdkMock.photographyUpdateBookingStatus.mockResolvedValue({
      ...booking('b1', { status: 'declined' }),
      clientEmailed: false,
    });
    render(PhotographyBookings);
    await fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByText(/Declining doesn’t refund it/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Decline booking' }));
    await waitFor(() =>
      expect(sdkMock.photographyUpdateBookingStatus).toHaveBeenCalledWith({
        id: 'b1',
        photographyBookingStatusDto: { status: 'declined', notifyClient: false },
      }),
    );
  });

  it('shows a request the moment it arrives, without a reload', async () => {
    sdkMock.photographyBookings.mockResolvedValue({ mailReady: true, bookings: [] });
    render(PhotographyBookings);
    expect(await screen.findByText('No booking requests yet')).toBeInTheDocument();
    sdkMock.photographyBookings.mockResolvedValue({
      mailReady: true,
      bookings: [booking('b5', { clientName: 'Taylor Chen' })],
    });
    handlers.get('on_photography_booking')?.('b5');
    expect(await screen.findByText('Taylor Chen')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(toastManager.primary).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'New booking request from Taylor Chen' }),
      { timeout: 6000 },
    );
  });
});
