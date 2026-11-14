import type { InvoiceRow } from 'src/repositories/photography-invoice.repository.js';
import { emailText } from 'src/emails/components/email-locale.js';
import { createClientsPdf } from 'src/utils/photography-contract-pdf.js';

/** FL-1081: an invoice as PDF/A-3b, rendered on request from its stored lines and totals (FL-1075 renderer). */
export function renderInvoicePdf(input: {
  row: InvoiceRow;
  label: string;
  studio: { name: string; email: string };
  locale: string;
  money: (amount: number) => string;
  date: (value: string) => string;
}) {
  const { row, studio, money, date, locale } = input;
  const t = (key: Parameters<typeof emailText>[1], values?: Record<string, string>) => emailText(locale, key, values);
  const title = t('invoice_pdf_title', { number: input.label });
  const { doc, done } = createClientsPdf(locale, { Title: title, Author: studio.name });
  const right = (text: string, y: number) =>
    doc.text(text, doc.page.margins.left, y, { width: doc.page.width - doc.page.margins.left * 2, align: 'right' });
  const pair = (label: string, value: string, bold = false) => {
    const y = doc.y;
    doc
      .font(bold ? 'sans' : 'serif')
      .fontSize(11)
      .fillColor('#111111')
      .text(label, doc.page.margins.left, y);
    right(value, y);
    doc.moveDown(0.3);
  };

  doc.font('sans').fontSize(10).fillColor('#555555').text([studio.name, studio.email].filter(Boolean).join(' · '));
  doc.moveDown(0.5).font('sans').fontSize(20).fillColor('#111111').text(title);
  doc
    .moveDown(0.3)
    .font('serif')
    .fontSize(11)
    .text(t('invoice_pdf_prepared_for', { name: row.clientName }));
  doc.moveDown();
  for (const line of row.lines) {
    const y = doc.y;
    doc
      .font('serif')
      .fontSize(11)
      .fillColor('#111111')
      .text(line.description, doc.page.margins.left, y, { width: 330 });
    right(money(line.quantity * line.unitPrice), y);
    doc
      .font('serif')
      .fontSize(9)
      .fillColor('#555555')
      .text(`${line.quantity} × ${money(line.unitPrice)}`);
    doc.moveDown(0.4);
  }
  doc.moveDown(0.5);
  pair(t('invoice_pdf_subtotal'), money(row.subtotal));
  pair(t('invoice_pdf_tax', { rate: String(row.taxBasisPoints / 100) }), money(row.tax));
  pair(t('invoice_pdf_total'), money(row.total), true);
  if (row.paid > 0) {
    pair(t('invoice_pdf_paid'), money(row.paid));
    pair(t('invoice_pdf_balance'), money(row.total - row.paid), true);
  }
  doc.moveDown().font('sans').fontSize(12).fillColor('#111111').text(t('invoice_pdf_schedule'), doc.page.margins.left);
  doc.moveDown(0.3);
  for (const item of row.schedule) pair(t('invoice_pdf_due', { date: date(item.dueOn) }), money(item.amount));
  doc.end();
  return done;
}
