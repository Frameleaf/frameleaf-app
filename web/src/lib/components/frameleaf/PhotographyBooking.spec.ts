import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PhotographyBookingTypes from './PhotographyBookingTypes.svelte';
import PhotographyStudioBooking from './PhotographyStudioBooking.svelte';

const type = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Family session',
  description: '',
  durationMinutes: 60,
  price: 30_000,
  deposit: 5000,
  currency: 'CAD',
  addOns: [{ id: 'xprints', name: 'Prints', price: 2500, maxQuantity: 3 }],
};
beforeAll(() => addMessages('dev', en));

describe('PhotographyStudioBooking', () => {
  it('adds the chosen add-ons to the total and sends only those', async () => {
    sdkMock.photographyRequestBooking.mockResolvedValue({
      total: 35_000,
      deposit: 5000,
      currency: 'CAD',
      checkoutUrl: null,
    });
    render(PhotographyStudioBooking, { open: true, site: 'cedar', types: [type] });
    await fireEvent.change(screen.getByLabelText('Quantity for Prints'), { target: { value: '2' } });
    expect(screen.getByText(/350\.00/)).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText('Your name'), { target: { value: 'Morgan' } });
    await fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'morgan@example.test' } });
    await fireEvent.input(screen.getByLabelText('Preferred date'), { target: { value: '2027-06-01' } });
    await fireEvent.submit(screen.getByRole('button', { name: 'Request booking' }).closest('form')!);
    expect(await screen.findByText('Booking request received')).toBeInTheDocument();
    expect(sdkMock.photographyRequestBooking).toHaveBeenCalledWith({
      site: 'cedar',
      photographyBookingRequestDto: expect.objectContaining({
        bookingTypeId: type.id,
        preferredDates: ['2027-06-01'],
        addOns: [{ id: 'xprints', quantity: 2 }],
      }),
    });
  });

  it('keeps what the visitor typed when sending fails', async () => {
    sdkMock.photographyRequestBooking.mockRejectedValue(new Error('offline'));
    render(PhotographyStudioBooking, { open: true, site: 'cedar', types: [type] });
    await fireEvent.input(screen.getByLabelText('Your name'), { target: { value: 'Morgan' } });
    await fireEvent.submit(screen.getByRole('button', { name: 'Request booking' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t be sent');
    expect(screen.getByLabelText('Your name')).toHaveValue('Morgan');
  });
});

describe('PhotographyBookingTypes', () => {
  it('lists the studio’s booking types with their add-on count', async () => {
    sdkMock.photographyBookingTypes.mockResolvedValue({
      types: [{ ...type, active: true, order: 0, createdAt: '2027-01-01T00:00:00.000Z' }],
    } as never);
    render(PhotographyBookingTypes);
    expect(await screen.findByText('Family session')).toBeInTheDocument();
    expect(screen.getByText('60 min · 1 add-on')).toBeInTheDocument();
  });

  it('saves a new type with prices in cents', async () => {
    sdkMock.photographyBookingTypes.mockResolvedValue({ types: [] });
    sdkMock.photographyCreateBookingType.mockImplementation(
      async ({ photographyBookingTypeSaveDto: dto }) => ({ ...dto, id: type.id, createdAt: '' }) as never,
    );
    render(PhotographyBookingTypes);
    await fireEvent.click(await screen.findByRole('button', { name: 'New booking type' }));
    await fireEvent.input(screen.getByLabelText('Session name'), { target: { value: 'Mini' } });
    await fireEvent.input(screen.getByLabelText('Price (CAD)'), { target: { value: '150.5' } });
    await fireEvent.submit(screen.getByRole('button', { name: 'Save booking type' }).closest('form')!);
    await waitFor(() =>
      expect(sdkMock.photographyCreateBookingType).toHaveBeenCalledWith({
        photographyBookingTypeSaveDto: expect.objectContaining({ name: 'Mini', price: 15_050, deposit: 0, addOns: [] }),
      }),
    );
  });
});
