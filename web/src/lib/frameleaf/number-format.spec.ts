import { locale } from '$lib/stores/preferences.store';
import { formatCount, formatMoney } from './number-format';

describe('counts and money (FL-1805)', () => {
  afterEach(() => locale.set('default'));

  it('groups a count for the given region, exactly as Intl does', () => {
    expect(formatCount(1_234_567, 'en-US')).toBe('1,234,567');
    expect(formatCount(1_234_567, 'de-DE')).toBe(new Intl.NumberFormat('de-DE').format(1_234_567));
    expect(formatCount(12.345, 'en-US', { maximumFractionDigits: 1 })).toBe('12.3');
  });

  it('follows the "Dates and numbers" region when given none, and the browser for "default"', () => {
    locale.set('de-DE');
    expect(formatCount(1234.5)).toBe(new Intl.NumberFormat('de-DE').format(1234.5));
    expect(formatCount(1234.5, 'default')).toBe(new Intl.NumberFormat().format(1234.5));
    expect(formatCount(1234.5, null)).toBe(new Intl.NumberFormat().format(1234.5));
    locale.set('default');
    expect(formatCount(1234.5)).toBe(new Intl.NumberFormat().format(1234.5));
  });

  it('writes an amount held in cents as money in its currency', () => {
    expect(formatMoney(1250, 'USD', 'en-US')).toBe('$12.50');
    expect(formatMoney(1250, 'EUR', 'de-DE')).toBe(
      new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(12.5),
    );
    expect(formatMoney(120_000, 'USD', 'en-US', { maximumFractionDigits: 0 })).toBe('$1,200');
  });

  it('builds one formatter per region and set of options', () => {
    const constructor = vi.spyOn(Intl, 'NumberFormat');
    for (let value = 0; value < 200; value++) {
      formatCount(value, 'en-IE', { minimumFractionDigits: 3 });
      formatMoney(value, 'NZD', 'en-IE');
    }
    expect(constructor).toHaveBeenCalledTimes(2);
    constructor.mockRestore();
  });
});
