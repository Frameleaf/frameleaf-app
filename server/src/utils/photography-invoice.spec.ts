import { describe, expect, it } from 'vitest';
import {
  invoiceLabel,
  invoiceNext,
  invoiceReminderDue,
  invoiceSchedule,
  invoiceStatus,
  invoiceTotals,
} from 'src/utils/photography-invoice.js';

describe('invoice arithmetic', () => {
  it('computes totals and tax in integer minor units, rounding tax half up', () => {
    const lines = [
      { description: 'Portrait session', quantity: 1, unitPrice: 27_500 },
      { description: 'Additional edits', quantity: 2, unitPrice: 3750 },
    ];
    expect(invoiceTotals(lines, 500)).toEqual({ subtotal: 35_000, tax: 1750, total: 36_750 });
    expect(invoiceTotals([{ description: 'x', quantity: 1, unitPrice: 10 }], 500).tax).toBe(1);
    expect(invoiceTotals([{ description: 'x', quantity: 1, unitPrice: 9 }], 500).tax).toBe(0);
  });

  it('splits a deposit from the balance and refuses an impossible schedule', () => {
    expect(invoiceSchedule(36_750, 10_000, '2027-05-22', '2027-06-22')).toEqual([
      { dueOn: '2027-05-22', amount: 10_000 },
      { dueOn: '2027-06-22', amount: 26_750 },
    ]);
    expect(invoiceSchedule(36_750, 0, null, '2027-06-22')).toEqual([{ dueOn: '2027-06-22', amount: 36_750 }]);
    expect(() => invoiceSchedule(36_750, 36_750, '2027-05-22', '2027-06-22')).toThrow();
    expect(() => invoiceSchedule(36_750, 100, null, '2027-06-22')).toThrow();
    expect(() => invoiceSchedule(36_750, 100, '2027-07-01', '2027-06-22')).toThrow();
    expect(() => invoiceSchedule(0, 0, null, '2027-06-22')).toThrow();
  });

  it('asks for the rest of the earliest instalment and moves to part-paid, then paid', () => {
    const schedule = invoiceSchedule(36_750, 10_000, '2027-05-22', '2027-06-22');
    expect(invoiceNext(schedule, 0)).toEqual({ amount: 10_000, dueOn: '2027-05-22' });
    expect(invoiceNext(schedule, 4000)).toEqual({ amount: 6000, dueOn: '2027-05-22' });
    expect(invoiceNext(schedule, 10_000)).toEqual({ amount: 26_750, dueOn: '2027-06-22' });
    expect(invoiceNext(schedule, 36_750)).toBeNull();
    expect([0, 1, 36_750].map((paid) => invoiceStatus(36_750, paid))).toEqual(['sent', 'part', 'paid']);
  });

  it('reminds three days before, on the due date, then weekly while overdue', () => {
    const due = (today: string) => invoiceReminderDue('2027-05-22', today);
    expect(['2027-05-19', '2027-05-22', '2027-05-29', '2027-06-05'].map((d) => due(d))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['2027-05-18', '2027-05-20', '2027-05-23', '2027-05-28'].map((d) => due(d))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(invoiceLabel(42)).toBe('CL-0042');
  });
});
