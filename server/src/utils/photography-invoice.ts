import type { InvoiceLine, InvoiceScheduleItem } from 'src/schema/tables/photography-invoice.table.js';

/** FL-1081: invoice arithmetic. Every amount is an integer in the smallest currency unit. */
export const invoiceTotals = (lines: InvoiceLine[], taxBasisPoints: number) => {
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  // Half up on a non-negative integer product; 500 basis points is 5%.
  const tax = Math.floor((subtotal * taxBasisPoints + 5000) / 10_000);
  return { subtotal, tax, total: subtotal + tax };
};

/** A deposit due first and the balance after it, or the whole total on one date. Throws a message on bad input. */
export const invoiceSchedule = (
  total: number,
  deposit: number,
  depositDue: string | null,
  balanceDue: string,
): InvoiceScheduleItem[] => {
  if (total <= 0) throw new Error('Add at least one paid item');
  if (deposit <= 0) return [{ dueOn: balanceDue, amount: total }];
  if (deposit >= total) throw new Error('The deposit must be less than the total');
  if (!depositDue) throw new Error('Choose when the deposit is due');
  if (depositDue > balanceDue) throw new Error('The deposit must be due before the balance');
  return [
    { dueOn: depositDue, amount: deposit },
    { dueOn: balanceDue, amount: total - deposit },
  ];
};

/** The amount the client can pay now: the rest of the earliest instalment not yet covered. Null when settled. */
export const invoiceNext = (schedule: InvoiceScheduleItem[], paid: number) => {
  let covered = 0;
  for (const item of schedule) {
    covered += item.amount;
    if (covered > paid) return { amount: covered - paid, dueOn: item.dueOn };
  }
  return null;
};

export const invoiceStatus = (total: number, paid: number) => (paid >= total ? 'paid' : paid > 0 ? 'part' : 'sent');

const day = 86_400_000;
/** Three days before the due date, on it, then every seven days while overdue. Dates are `YYYY-MM-DD`. */
export const invoiceReminderDue = (dueOn: string, today: string) => {
  const daysLeft = Math.round((Date.parse(dueOn) - Date.parse(today)) / day);
  return daysLeft === 3 || daysLeft === 0 || (daysLeft < 0 && -daysLeft % 7 === 0);
};

export const invoiceLabel = (number: number) => `CL-${String(number).padStart(4, '0')}`;
