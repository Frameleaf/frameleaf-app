import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contractEventSha256 } from 'src/repositories/photography-contract.repository.js';
import { PhotographyContractService } from 'src/services/photography-contract.service.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const body = 'Cedar & Light will photograph Morgan Ellis.';
const contract = {
  id: 'contract',
  ownerId: 'owner',
  templateId: 'template',
  name: 'Portrait agreement',
  clientName: 'Morgan Ellis',
  clientEmail: 'morgan@example.test',
  body,
  documentSha256: sha256(body),
  status: 'viewed',
  tokenHash: null,
  tokenExpiresAt: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  sentAt: null,
  signedAt: null,
  signerName: null,
  signatureType: null,
  signaturePng: null,
  pdfPath: null,
  finalPdfSha256: null,
};
const token = 'a'.repeat(64);
const request = { ip: '203.0.113.9', userAgent: 'Test' };

describe(PhotographyContractService.name, () => {
  let sut: PhotographyContractService;
  let mocks: ServiceMocks;
  const contracts = {
    template: vi.fn(),
    createTemplate: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    send: vi.fn(),
    byToken: vi.fn(),
    viewed: vi.fn(),
    sign: vi.fn(),
    finalize: vi.fn(),
    events: vi.fn(),
  };
  const delivery = vi.fn();
  const auth = factory.auth({ session: {} });

  beforeEach(() => {
    vi.resetAllMocks();
    ({ sut, mocks } = newTestService(PhotographyContractService));
    Object.assign(sut, {
      contracts,
      campaigns: { delivery },
      workspace: { get: vi.fn().mockResolvedValue({ value: { brand: { name: 'Cedar & Light', color: '#577059' } } }) },
      studioRecords: { studioOwner: vi.fn().mockResolvedValue({ name: 'Owner', email: 'studio@example.test' }) },
      workflow: {
        studioOwner: (candidate: typeof auth) => {
          if (!candidate.session || candidate.apiKey || candidate.sharedLink) throw new ForbiddenException();
          return candidate.user.id;
        },
      },
    });
    mocks.user.getMetadata.mockResolvedValue([]);
    delivery.mockResolvedValue({
      ready: true,
      baseUrl: 'https://studio.test',
      smtp: { from: 'studio@x.test', transport: {} },
    });
    mocks.email.sendEmail.mockResolvedValue({ messageId: 'sent', response: 'ok' });
    contracts.events.mockResolvedValue([]);
  });

  it('refuses a template with a merge field outside the allow-list', async () => {
    await expect(sut.createTemplate(auth, { name: 'A', body: 'Hi {client_name}, {deposit}' })).rejects.toThrow(
      'Unknown merge field: deposit',
    );
    expect(contracts.createTemplate).not.toHaveBeenCalled();
  });

  it('freezes canonical text at creation and hashes exactly those bytes', async () => {
    contracts.template.mockResolvedValue({ id: 'template', name: 'Agreement', body: 'Café {client_name}\r\n{total}' });
    contracts.create.mockImplementation((value) => ({ ...contract, ...value }));
    const result = await sut.create(auth, {
      templateId: 'template',
      clientName: 'Morgan',
      clientEmail: 'Morgan@Example.test',
      total: '$350.00',
    });
    expect(result.body).toBe('Café Morgan\n$350.00');
    expect(result.documentSha256).toBe(sha256(Buffer.from('Café Morgan\n$350.00', 'utf8')));
    expect(result.clientEmail).toBe('morgan@example.test');
    contracts.template.mockResolvedValue({ id: 'template', name: 'Agreement', body: 'On {session_date}' });
    await expect(
      sut.create(auth, { templateId: 'template', clientName: 'M', clientEmail: 'm@example.test' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores only a hash of the 30-day link it emails', async () => {
    contracts.get.mockResolvedValue({ ...contract, status: 'draft' });
    contracts.send.mockImplementation((_owner, _id, tokenHash, tokenExpiresAt) => ({
      ...contract,
      status: 'sent',
      tokenHash,
      tokenExpiresAt,
    }));
    await sut.send(auth, 'contract');
    const { 2: tokenHash, 3: expiresAt } = contracts.send.mock.calls[0];
    const html: string = mocks.email.sendEmail.mock.calls[0][0].html;
    const sent = html.match(/photography\/sign\/([a-f\d]{64})/)![1];
    expect(sha256(sent)).toBe(tokenHash);
    expect(html).not.toContain(tokenHash);
    expect((expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
  });

  it('blocks signing when the text the signer read is not the text that was sent', async () => {
    contracts.byToken.mockResolvedValue(contract);
    const dto = { name: 'Morgan', signatureType: 'typed', consent: true, documentSha256: 'b'.repeat(64) } as const;
    await expect(sut.sign(token, dto, request)).rejects.toBeInstanceOf(ConflictException);
    contracts.sign.mockResolvedValue(null);
    await expect(sut.sign(token, { ...dto, documentSha256: contract.documentSha256 }, request)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('only exposes a contract through a well-formed live token', async () => {
    await expect(sut.publicView('not-a-token', request)).rejects.toBeInstanceOf(NotFoundException);
    expect(contracts.byToken).not.toHaveBeenCalled();
    contracts.byToken.mockResolvedValue(undefined);
    await expect(sut.publicView(token, request)).rejects.toBeInstanceOf(NotFoundException);
    expect(contracts.byToken).toHaveBeenCalledWith(sha256(token));
  });

  it('refuses a drawn signature that is not a PNG', async () => {
    contracts.byToken.mockResolvedValue(contract);
    const dto = {
      name: 'Morgan',
      signatureType: 'drawn',
      signaturePng: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`,
      consent: true,
      documentSha256: contract.documentSha256,
    } as const;
    await expect(sut.sign(token, dto, request)).rejects.toBeInstanceOf(BadRequestException);
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await expect(
      sut.sign(token, { ...dto, signaturePng: `data:image/png;base64,${truncated.toString('base64')}` }, request),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(contracts.sign).not.toHaveBeenCalled();
  });

  it('keeps a drawn signature even when sealing has to wait', async () => {
    const drawn = await sharp({ create: { width: 60, height: 20, channels: 4, background: '#000000ff' } })
      .png()
      .toBuffer();
    contracts.byToken.mockResolvedValue(contract);
    contracts.sign.mockResolvedValue({ ...contract, status: 'signed', signatureType: 'drawn', signedAt: new Date() });
    mocks.storage.createFile.mockRejectedValue(new Error('disk full'));
    await expect(
      sut.sign(
        token,
        {
          name: 'Morgan',
          signatureType: 'drawn',
          signaturePng: `data:image/png;base64,${drawn.toString('base64')}`,
          consent: true,
          documentSha256: contract.documentSha256,
        },
        request,
      ),
    ).resolves.toBeDefined();
    expect(contracts.sign.mock.calls[0][2].signaturePng.subarray(1, 4).toString()).toBe('PNG');
    expect(mocks.email.sendEmail).not.toHaveBeenCalled();
  });

  it('seals a signed contract as PDF/A with audit.json and records the PDF hash', async () => {
    const signed = {
      ...contract,
      status: 'signed',
      signerName: 'Morgan Ellis',
      signatureType: 'typed',
      signedAt: new Date(),
    };
    contracts.byToken.mockResolvedValueOnce(contract).mockResolvedValue({ ...signed, pdfPath: '/x.pdf' });
    contracts.sign.mockResolvedValue(signed);
    contracts.finalize.mockImplementation((_id, pdfPath, finalPdfSha256) => ({ ...signed, pdfPath, finalPdfSha256 }));
    await sut.sign(
      token,
      { name: 'Morgan Ellis', signatureType: 'typed', consent: true, documentSha256: contract.documentSha256 },
      request,
    );
    expect(contracts.sign).toHaveBeenCalledWith('contract', sha256(token), expect.anything(), request);
    const [path, pdf] = mocks.storage.createFile.mock.calls[0] as [string, Buffer];
    expect(path).toMatch(/clients-contracts\/contract-[\da-f-]+\.pdf$/);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.includes('pdfaid:part')).toBe(true);
    expect(pdf.includes('(audit.json)')).toBe(true);
    expect(contracts.finalize).toHaveBeenCalledWith('contract', path, sha256(pdf));
    expect(mocks.email.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('chains each audit event to the one before', () => {
    const first = {
      seq: 1,
      type: 'created',
      actor: 'studio',
      at: '2027-01-01T00:00:00.000Z',
      ip: null,
      userAgent: null,
      data: {},
      prevEventSha256: null,
    } as const;
    const firstSha = contractEventSha256(first);
    const second = { ...first, seq: 2, type: 'sent', prevEventSha256: firstSha } as const;
    expect(contractEventSha256(second)).not.toBe(contractEventSha256({ ...second, prevEventSha256: 'x' }));
    expect(contractEventSha256({ ...first, data: { edited: true } })).not.toBe(firstSha);
  });
});
