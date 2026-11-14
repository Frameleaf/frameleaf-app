import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { ContractEvent } from 'src/repositories/photography-contract.repository.js';
import { emailText } from 'src/emails/components/email-locale.js';

const fontRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/fonts');
const serif = resolve(fontRoot, 'noto-serif.ttf');
const sans = resolve(fontRoot, 'google-sans.ttf');
const script = resolve(fontRoot, 'great-vibes.ttf');

export const CONTRACT_RECORD_FORMAT = 'frameleaf.contract-record/v1';
export const CONTRACT_CONSENT_TEXT = 'I’ve read the agreement and agree to sign electronically.';

export type ContractAudit = {
  format: typeof CONTRACT_RECORD_FORMAT;
  contractId: string;
  name: string;
  studio: { name: string; email: string };
  signer: { name: string; email: string; signatureType: string };
  documentSha256: string;
  consentText: string;
  consentSha256: string;
  events: ContractEvent[];
};

const eventKey = {
  created: 'contract_pdf_event_created',
  sent: 'contract_pdf_event_sent',
  email_verified: 'contract_pdf_event_email_verified',
  viewed: 'contract_pdf_event_viewed',
  consented: 'contract_pdf_event_consented',
  signed: 'contract_pdf_event_signed',
  finalized: 'contract_pdf_event_finalized',
  voided: 'contract_pdf_event_voided',
} as const;

/**
 * FL-1075 record: the contract text, the signature and a Signing certificate page, saved as PDF/A-3b with
 * `audit.json` attached. The caller stores the SHA-256 of the result; it is never written into the PDF itself.
 */
export function renderContractPdf(input: {
  body: string;
  signatureType: string;
  signaturePng: Buffer | null;
  signedAt: Date;
  audit: ContractAudit;
  locale: string;
}): Promise<Buffer> {
  const { audit, locale } = input;
  const t = (key: Parameters<typeof emailText>[1], values?: Record<string, string>) => emailText(locale, key, values);
  const when = (iso: string | Date) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));
  const doc = new PDFDocument({
    pdfVersion: '1.7',
    subset: 'PDF/A-3b',
    font: serif,
    size: 'LETTER',
    margin: 64,
    lang: locale,
    displayTitle: true,
    info: { Title: audit.name, Author: audit.studio.name, Subject: CONTRACT_RECORD_FORMAT },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('serif', serif);
  doc.registerFont('sans', sans);
  doc.registerFont('script', script);

  doc.font('sans').fontSize(10).fillColor('#555555').text(audit.studio.name);
  doc.moveDown(0.5).font('sans').fontSize(20).fillColor('#111111').text(audit.name);
  doc.moveDown().font('serif').fontSize(11).text(input.body, { lineGap: 3 });

  doc.moveDown(2);
  if (doc.y > doc.page.height - 200) doc.addPage();
  if (input.signaturePng) {
    doc.image(input.signaturePng, { fit: [240, 80] });
  } else {
    doc.font('script').fontSize(32).text(audit.signer.name);
  }
  doc
    .font('sans')
    .fontSize(10)
    .fillColor('#555555')
    .text(t('contract_pdf_signed_by', { name: audit.signer.name, date: when(input.signedAt) }));

  doc.addPage();
  doc.font('sans').fontSize(18).fillColor('#111111').text(t('contract_pdf_certificate'));
  doc.moveDown();
  const row = (label: string, value: string) => {
    doc.font('sans').fontSize(9).fillColor('#555555').text(label);
    doc.font('serif').fontSize(10).fillColor('#111111').text(value).moveDown(0.5);
  };
  row(t('contract_pdf_record'), `${audit.contractId} (${CONTRACT_RECORD_FORMAT})`);
  row(t('contract_pdf_studio'), `${audit.studio.name} <${audit.studio.email}>`);
  row(t('contract_pdf_signer'), `${audit.signer.name} <${audit.signer.email}>`);
  row(t('contract_pdf_document_hash'), audit.documentSha256);
  row(t('contract_pdf_consent'), audit.consentText);
  doc.moveDown().font('sans').fontSize(12).fillColor('#111111').text(t('contract_pdf_history'));
  doc.moveDown(0.5);
  for (const event of audit.events) {
    const source = [event.ip, event.userAgent].filter(Boolean).join(' · ');
    doc
      .font('sans')
      .fontSize(10)
      .fillColor('#111111')
      .text(`${when(event.at)} — ${t(eventKey[event.type])}`);
    if (source) doc.font('serif').fontSize(8).fillColor('#555555').text(source);
    doc.font('serif').fontSize(7).fillColor('#777777').text(event.sha256).moveDown(0.4);
  }
  doc.moveDown().font('sans').fontSize(8).fillColor('#555555').text(t('contract_pdf_attachment'));

  doc.file(Buffer.from(JSON.stringify(audit, null, 2)), {
    name: 'audit.json',
    type: 'application/json',
    description: CONTRACT_RECORD_FORMAT,
    relationship: 'Data',
    creationDate: input.signedAt,
    modifiedDate: input.signedAt,
  } as PDFKit.Mixins.PDFAttachmentOptions & { relationship: string });
  doc.end();
  return done;
}
