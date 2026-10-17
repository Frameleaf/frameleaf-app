import { render, screen } from '@testing-library/svelte';
import { DateTime } from 'luxon';
import { get } from 'svelte/store';
import { locale } from '$lib/stores/preferences.store';
import SupportedDatetimePanel from './SupportedDatetimePanel.svelte';

it('recreates one sample date when locale changes and updates its formatted month', async () => {
  const initialLocale = get(locale);
  const parse = vi.spyOn(DateTime, 'fromISO');
  try {
    locale.set('en');
    render(SupportedDatetimePanel, {
      options: {
        yearOptions: [],
        monthOptions: ['MMMM'],
        weekOptions: [],
        dayOptions: [],
        hourOptions: [],
        minuteOptions: [],
        secondOptions: [],
        presetOptions: [],
      },
    });
    await screen.findByText('{{MMMM}} - February');
    parse.mockClear();
    locale.set('fr');
    await screen.findByText('{{MMMM}} - février');
    expect(parse).toHaveBeenCalledOnce();
  } finally {
    locale.set(initialLocale);
    parse.mockRestore();
  }
});
