import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { render, toPlainText } from '@react-email/render';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createElement } from 'react';
import sharp from 'sharp';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  CONTRACT_MERGE_FIELDS,
  PhotographyContractCreateDto,
  PhotographyContractSignDto,
  PhotographyContractTemplateSaveDto,
} from 'src/dtos/photography-contract.dto.js';
import { EmailLocaleContext, emailText } from 'src/emails/components/email-locale.js';
import PhotographyContractEmail from 'src/emails/photography-contract.email.js';
import { StorageFolder } from 'src/enum.js';
import { ContractRow, PhotographyContractRepository } from 'src/repositories/photography-contract.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotographyCampaignService } from 'src/services/photography-campaign.service.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { sendConnectedEmail } from 'src/utils/mail-connection.js';
import {
  CONTRACT_CONSENT_TEXT,
  CONTRACT_RECORD_FORMAT,
  ContractAudit,
  renderContractPdf,
} from 'src/utils/photography-contract-pdf.js';
import { localeOf } from 'src/utils/preferences.js';

const LINK_DAYS = 30;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Canonical text (FL-1075): NFC, LF line endings, no trailing whitespace on the whole. */
const canonical = (text: string) => text.normalize('NFC').replaceAll(/\r\n?/g, '\n').trim();
const fieldPattern = /\{([a-z_]+)\}/g;
const allowed = new Set<string>(CONTRACT_MERGE_FIELDS);
const unknownFields = (body: string) =>
  body
    .matchAll(fieldPattern)
    .map(([, f]) => f)
    .filter((f) => !allowed.has(f))
    .toArray();
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const contractsFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'clients-contracts');
/** Decodes the drawn signature fully (sharp) and re-encodes it, so only a small, valid PNG reaches the PDF. */
const signaturePng = async (dataUrl: string) => {
  const input = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  try {
    const image = sharp(input, { limitInputPixels: 2000 * 1000 });
    const { format, width = 0, height = 0 } = await image.metadata();
    if (input.length <= 256_000 && format === 'png' && width <= 2000 && height <= 1000) {
      return await image.png().toBuffer();
    }
  } catch {
    // An undecodable image is refused below.
  }
  throw new BadRequestException('Signature image is invalid');
};

export const contractView = (row: ContractRow) => ({
  id: row.id,
  templateId: row.templateId,
  name: row.name,
  clientName: row.clientName,
  clientEmail: row.clientEmail,
  body: row.body,
  documentSha256: row.documentSha256,
  status: row.status as 'draft' | 'sent' | 'viewed' | 'signed' | 'void',
  createdAt: iso(row.createdAt)!,
  sentAt: iso(row.sentAt),
  signedAt: iso(row.signedAt),
  signerName: row.signerName,
  finalPdfSha256: row.finalPdfSha256,
});
const templateView = (row: { id: string; name: string; body: string; updatedAt: Date | string }) => ({
  ...row,
  updatedAt: iso(row.updatedAt)!,
});
type RequestInfo = { ip: string | null; userAgent: string | null };

/** FL-1076: contracts built from templates, signed on a public link, sealed as a PDF with a hash-chained audit. */
@Injectable()
export class PhotographyContractService extends BaseService {
  @Inject(PhotographyContractRepository) private contracts!: PhotographyContractRepository;
  @Inject(PhotographyWorkflowRepository) private studioRecords!: PhotographyWorkflowRepository;
  @Inject(PhotographyWorkspaceRepository) private workspace!: PhotographyWorkspaceRepository;
  @Inject(PhotographyWorkflowService) private workflow!: PhotographyWorkflowService;
  @Inject(PhotographyCampaignService) private campaigns!: PhotographyCampaignService;

  async templates(auth: AuthDto) {
    const rows = await this.contracts.templates(this.workflow.studioOwner(auth));
    return { items: rows.map((row) => templateView(row)), fields: [...CONTRACT_MERGE_FIELDS] };
  }
  async createTemplate(auth: AuthDto, dto: PhotographyContractTemplateSaveDto) {
    return templateView(await this.contracts.createTemplate(this.workflow.studioOwner(auth), this.checked(dto)));
  }
  async updateTemplate(auth: AuthDto, id: string, dto: PhotographyContractTemplateSaveDto) {
    return templateView(await this.contracts.updateTemplate(this.workflow.studioOwner(auth), id, this.checked(dto)));
  }
  deleteTemplate(auth: AuthDto, id: string) {
    return this.contracts.deleteTemplate(this.workflow.studioOwner(auth), id);
  }
  private checked(dto: PhotographyContractTemplateSaveDto) {
    const value = PhotographyContractTemplateSaveDto.schema.parse(dto);
    const unknown = unknownFields(value.body);
    if (unknown.length > 0) throw new BadRequestException(`Unknown merge field: ${unknown[0]}`);
    return value;
  }

  async list(auth: AuthDto) {
    const rows = await this.contracts.list(this.workflow.studioOwner(auth));
    const { ready } = await this.campaigns.delivery();
    return { items: rows.map((row) => contractView(row)), mailReady: ready };
  }
  async get(auth: AuthDto, id: string) {
    return contractView(await this.contracts.get(this.workflow.studioOwner(auth), id));
  }
  /** Fills the merge fields once; the text is frozen from here on and only voiding replaces it. */
  async create(auth: AuthDto, dto: PhotographyContractCreateDto) {
    const ownerId = this.workflow.studioOwner(auth);
    const input = dto;
    const template = await this.contracts.template(ownerId, input.templateId);
    const locale = localeOf(await this.userRepository.getMetadata(ownerId));
    const values: Record<string, string | undefined> = {
      client_name: input.clientName,
      session_date:
        input.sessionDate &&
        new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(input.sessionDate)),
      total: input.total,
    };
    const missing = new Set<string>();
    const body = canonical(
      template.body.replaceAll(fieldPattern, (token, field: string) => {
        if (!allowed.has(field)) throw new BadRequestException(`Unknown merge field: ${field}`);
        const value = values[field];
        if (!value) missing.add(field);
        return value ?? token;
      }),
    );
    if (missing.size > 0) throw new BadRequestException(`Fill in ${[...missing].join(', ')}`);
    const studio = await this.studio(ownerId);
    const row = await this.contracts.create(
      {
        ownerId,
        templateId: template.id,
        name: template.name,
        clientName: input.clientName,
        clientEmail: input.clientEmail.toLowerCase(),
        body,
        documentSha256: sha256(Buffer.from(body, 'utf8')),
      },
      { name: studio.name, email: studio.email },
    );
    return contractView(row);
  }
  /** Sends (or re-sends) the signing link. A new link replaces the old one. */
  async send(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    const current = await this.contracts.get(ownerId, id);
    const delivery = await this.campaigns.delivery();
    if (!delivery.ready) throw new BadRequestException('Configure email delivery and your public address first');
    const token = randomBytes(32).toString('hex');
    const row = await this.contracts.send(ownerId, id, sha256(token), new Date(Date.now() + LINK_DAYS * 86_400_000));
    if (!row) throw new ConflictException(`A ${current.status} contract can’t be sent`);
    const studio = await this.studio(ownerId);
    await this.mail(delivery, row.clientEmail, studio.locale, {
      subject: emailText(studio.locale, 'contract_email_subject', { studio: studio.name }),
      heading: row.name,
      body: emailText(studio.locale, 'contract_email_body', { studio: studio.name, days: String(LINK_DAYS) }),
      button: emailText(studio.locale, 'contract_email_button'),
      url: `${delivery.baseUrl}/photography/sign/${token}`,
      studio,
    });
    return contractView(row);
  }
  async void(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    const current = await this.contracts.get(ownerId, id);
    const row = await this.contracts.void(ownerId, id);
    if (!row) throw new ConflictException(`A ${current.status} contract can’t be voided`);
    return contractView(row);
  }
  async delete(auth: AuthDto, id: string) {
    const ownerId = this.workflow.studioOwner(auth);
    await this.contracts.delete(ownerId, id, (path) => this.storageRepository.unlinkIfExists(path));
  }
  async pdf(auth: AuthDto, id: string) {
    const row = await this.signed(await this.contracts.get(this.workflow.studioOwner(auth), id));
    return { name: `${row.name}.pdf`, buffer: await this.storageRepository.readFile(row.pdfPath!) };
  }
  /** The dispute bundle: anyone can check it with `sha256sum -c SHA256SUMS`, without Frameleaf. */
  async export(auth: AuthDto, id: string) {
    const row = await this.signed(await this.contracts.get(this.workflow.studioOwner(auth), id));
    const pdf = await this.storageRepository.readFile(row.pdfPath!);
    const audit = Buffer.from(JSON.stringify(await this.audit(row, true), null, 2));
    const sums = `${sha256(pdf)}  contract-signed.pdf\n${sha256(audit)}  audit.json\n`;
    const zip = this.storageRepository.createZipStream();
    zip.addFile(pdf, 'contract-signed.pdf');
    zip.addFile(audit, 'audit.json');
    zip.addFile(Buffer.from(sums), 'SHA256SUMS');
    void zip.finalize().catch((error: Error) => zip.stream.destroy(error));
    return { name: `${row.name}.zip`, stream: zip.stream };
  }

  async publicView(token: string, request: RequestInfo) {
    let row = await this.byToken(token);
    if (row.status === 'sent') row = (await this.contracts.viewed(row.id, request, row.clientEmail)) ?? row;
    const studio = await this.studio(row.ownerId);
    const history = row.status === 'signed' ? await this.contracts.events(row.id) : [];
    return {
      studio: { name: studio.name, email: studio.email, color: studio.color },
      name: row.name,
      body: row.body,
      documentSha256: row.documentSha256,
      signed: row.status === 'signed',
      signerName: row.signerName,
      signedAt: iso(row.signedAt),
      history: history.map(({ type, at }) => ({ type, at })),
    };
  }
  async sign(token: string, dto: PhotographyContractSignDto, request: RequestInfo) {
    const input = PhotographyContractSignDto.schema.parse(dto);
    const row = await this.byToken(token);
    if (row.status === 'signed') throw new ConflictException('This agreement is already signed');
    if (row.documentSha256 !== input.documentSha256)
      throw new ConflictException('The agreement changed. Ask the studio for a new link.');
    let png: Buffer | null = null;
    if (input.signatureType === 'drawn') {
      if (!input.signaturePng) throw new BadRequestException('Draw your signature');
      png = await signaturePng(input.signaturePng);
    }
    const signed = await this.contracts.sign(
      row.id,
      sha256(token),
      {
        name: input.name,
        signatureType: input.signatureType,
        signaturePng: png,
        documentSha256: input.documentSha256,
        consentSha256: sha256(CONTRACT_CONSENT_TEXT),
      },
      request,
    );
    if (!signed) throw new ConflictException('The agreement changed. Ask the studio for a new link.');
    // The signature is recorded; a seal that fails here is completed the next time the PDF is asked for.
    await this.finalize(signed).catch(() => this.logger.warn('A signed contract could not be sealed yet'));
    return this.publicView(token, request);
  }
  async publicPdf(token: string) {
    const row = await this.signed(await this.byToken(token));
    return { name: `${row.name}.pdf`, buffer: await this.storageRepository.readFile(row.pdfPath!) };
  }

  private async byToken(token: string) {
    if (!/^[a-f\d]{64}$/.test(token)) throw new NotFoundException('This agreement link is unavailable');
    const row = await this.contracts.byToken(sha256(token));
    if (!row) throw new NotFoundException('This agreement link is unavailable');
    return row;
  }
  private async signed(row: ContractRow) {
    if (row.status !== 'signed') throw new NotFoundException('The contract isn’t signed yet');
    return this.finalize(row);
  }
  /**
   * Renders and stores the sealed PDF once; safe to call again if a previous attempt stopped half way.
   * The request that seals it also emails the signed copy, so a seal finished later still notifies.
   */
  private async finalize(row: ContractRow): Promise<ContractRow> {
    if (row.pdfPath) return row;
    const studio = await this.studio(row.ownerId);
    const pdf = await renderContractPdf({
      body: row.body,
      signatureType: row.signatureType!,
      signaturePng: row.signaturePng,
      signedAt: new Date(row.signedAt!),
      audit: await this.audit(row, false),
      locale: studio.locale,
    });
    const folder = contractsFolder(row.ownerId);
    this.storageRepository.mkdirSync(folder);
    // A unique name per render: if two requests seal at once, the one that loses removes only its own file.
    const path = join(folder, `${row.id}-${randomUUID()}.pdf`);
    await this.storageRepository.createFile(path, pdf);
    let sealed: ContractRow | null;
    try {
      sealed = await this.contracts.finalize(row.id, path, sha256(pdf));
    } catch (error) {
      // Remove the file only once the database is known not to reference it (the commit may have landed):
      // the contract is gone, or it points at another file. The re-read waits on the row lock; if it fails, keep the file.
      const committed = await this.contracts.committedPdfPath(row.id).catch(() => path);
      if (committed !== path) {
        await this.storageRepository.unlinkIfExists(path);
      }
      throw error;
    }
    if (!sealed) {
      await this.storageRepository.unlinkIfExists(path);
      return this.contracts.get(row.ownerId, row.id);
    }
    await this.notifySigned(sealed).catch(() => this.logger.warn('A signed-contract email could not be sent'));
    return sealed;
  }
  private async audit(row: ContractRow, withFinal: boolean): Promise<ContractAudit & { finalPdfSha256?: string }> {
    const events = await this.contracts.events(row.id);
    const frozen = events[0]?.data.studio as { name: string; email: string } | undefined;
    const studio = frozen ?? (await this.studio(row.ownerId));
    return {
      format: CONTRACT_RECORD_FORMAT,
      contractId: row.id,
      name: row.name,
      studio: { name: studio.name, email: studio.email },
      signer: { name: row.signerName ?? '', email: row.clientEmail, signatureType: row.signatureType ?? '' },
      documentSha256: row.documentSha256,
      consentText: CONTRACT_CONSENT_TEXT,
      consentSha256: sha256(CONTRACT_CONSENT_TEXT),
      events,
      ...(withFinal && row.finalPdfSha256 ? { finalPdfSha256: row.finalPdfSha256 } : {}),
    };
  }
  private async studio(ownerId: string) {
    const [workspace, owner, metadata] = await Promise.all([
      this.workspace.get(ownerId),
      this.studioRecords.studioOwner(ownerId),
      this.userRepository.getMetadata(ownerId),
    ]);
    const brand = workspace?.value.brand;
    return {
      name: brand?.name || owner?.name || 'Frameleaf',
      email: brand?.email || owner?.email || '',
      ownerEmail: owner?.email ?? '',
      color: /^#[a-f\d]{6}$/i.test(brand?.color ?? '') ? brand!.color : '#577059',
      locale: localeOf(metadata),
    };
  }
  private async notifySigned(row: ContractRow) {
    const delivery = await this.campaigns.delivery();
    if (!delivery.ready || !row.pdfPath) return;
    const studio = await this.studio(row.ownerId);
    const message = {
      subject: emailText(studio.locale, 'contract_signed_subject', { name: row.name }),
      heading: row.name,
      body: emailText(studio.locale, 'contract_signed_body', { name: row.name, signer: row.signerName ?? '' }),
      studio,
      attachment: row.pdfPath,
    };
    // Each recipient is attempted on its own, so one failed address doesn't stop the other.
    const recipients = [row.clientEmail, studio.ownerEmail].filter(Boolean);
    const results = await Promise.allSettled(recipients.map((to) => this.mail(delivery, to, studio.locale, message)));
    if (results.some(({ status }) => status === 'rejected')) {
      this.logger.warn('A signed-contract email could not be sent');
    }
  }
  private async mail(
    delivery: Awaited<ReturnType<PhotographyCampaignService['delivery']>>,
    to: string,
    locale: string,
    message: {
      subject: string;
      heading: string;
      body: string;
      button?: string;
      url?: string;
      attachment?: string;
      studio: { name: string; color: string; email: string };
    },
  ) {
    const html = await render(
      createElement(
        EmailLocaleContext.Provider,
        { value: locale },
        createElement(PhotographyContractEmail, {
          studioName: message.studio.name,
          color: message.studio.color,
          heading: message.heading,
          body: message.body,
          button: message.button,
          url: message.url,
        }),
      ),
    );
    const { smtp, provider } = delivery;
    const payload = {
      from: smtp.from,
      replyTo: message.studio.email || smtp.replyTo || smtp.from,
      to,
      subject: message.subject,
      html,
      text: toPlainText(html),
      imageAttachments: message.attachment
        ? [{ filename: 'contract-signed.pdf', path: message.attachment, cid: 'contract-signed.pdf' }]
        : undefined,
    };
    await (provider
      ? sendConnectedEmail(this.mailDeps, provider, payload)
      : this.emailRepository.sendEmail({ ...payload, smtp: smtp.transport }));
  }
}
