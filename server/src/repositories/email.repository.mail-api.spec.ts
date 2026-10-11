import { MailSignInProvider } from 'src/enum.js';
import {
  EmailRepository,
  GMAIL_SEND_URL,
  GRAPH_ME_URL,
  GRAPH_SEND_URL,
  MailApiError,
} from 'src/repositories/email.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { automock } from 'test/utils.js';

const ACCESS = 'access-token-FIXTURE-ONLY';
const message = {
  to: 'ana@example.com',
  from: 'Rivera photos <rivera@example.com>',
  replyTo: 'family@example.com',
  subject: 'Test email from Frameleaf',
  html: '<p>Hello <b>Ana</b></p>',
  text: 'Hello Ana',
};

/** FL-379: the last hop for a connected account. Gmail and Microsoft are a stubbed `fetch`; nothing leaves the machine. */
describe(`${EmailRepository.name} (Gmail and Microsoft)`, () => {
  let sut: EmailRepository;
  let logger: ReturnType<typeof automock<LoggingRepository>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const sent = () => fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];

  /** What a mail reader would see: headers unfolded, and each part's body. */
  const expectMime = (mime: string) => {
    expect(mime).toContain('From: Rivera photos <rivera@example.com>\r\n');
    expect(mime).toContain('To: ana@example.com\r\n');
    expect(mime).toContain('Reply-To: family@example.com\r\n');
    expect(mime).toContain('Subject: Test email from Frameleaf\r\n');
    expect(mime).toMatch(/Message-ID: <[^>]+>\r\n/);
    expect(mime).toContain('MIME-Version: 1.0\r\n');
    expect(mime).toMatch(/Content-Type: multipart\/alternative;\s+boundary=/);
    expect(mime).toMatch(/Content-Type: text\/plain; charset=utf-8\r\n[\s\S]*Hello Ana/);
    expect(mime).toMatch(/Content-Type: text\/html; charset=utf-8\r\n[\s\S]*<p>Hello <b>Ana<\/b><\/p>/);
  };

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    logger = automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false });
    sut = new EmailRepository(logger);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the whole MIME message to the Gmail API as base64url `raw`', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: 'gmail-id', threadId: 'thread' }));

    const result = await sut.sendEmailWithAccount({
      ...message,
      account: { provider: MailSignInProvider.Gmail, accessToken: ACCESS },
    });

    const [url, init] = sent();
    expect(url).toBe(GMAIL_SEND_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS}` });
    const body = JSON.parse(init.body as string) as { raw: string };
    expect(Object.keys(body)).toEqual(['raw']);
    expect(body.raw).toMatch(/^[\w-]+$/);
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    expectMime(mime);
    expect(mime).toContain(`Message-ID: ${result.messageId}`);
  });

  it('posts the whole MIME message to Microsoft Graph /me/sendMail as base64 text', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    const result = await sut.sendEmailWithAccount({
      ...message,
      account: { provider: MailSignInProvider.Microsoft, accessToken: ACCESS },
    });

    const [url, init] = sent();
    expect(url).toBe(GRAPH_SEND_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain', Authorization: `Bearer ${ACCESS}` });
    expect(init.body).toMatch(/^[\d+/=A-Za-z]+$/);
    expectMime(Buffer.from(init.body as string, 'base64').toString('utf8'));
    expect(result.response).toBe('Microsoft accepted the message (202)');
  });

  it('reports a refusal with the provider’s own reason and its status', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } },
        { status: 401 },
      ),
    );

    const error = await sut
      .sendEmailWithAccount({ ...message, account: { provider: MailSignInProvider.Gmail, accessToken: ACCESS } })
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(MailApiError);
    expect(error).toMatchObject({ status: 401, message: 'Gmail refused (401): Invalid Credentials' });
  });

  it('reports a provider that does not answer', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(
      sut.sendEmailWithAccount({
        ...message,
        account: { provider: MailSignInProvider.Microsoft, accessToken: ACCESS },
      }),
    ).rejects.toMatchObject({ status: null, message: 'Microsoft did not answer: getaddrinfo ENOTFOUND' });
  });

  it('never logs the token or the message', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { message: 'nope' } }, { status: 403 }));
    await sut
      .sendEmailWithAccount({ ...message, account: { provider: MailSignInProvider.Gmail, accessToken: ACCESS } })
      .catch(() => {});

    const logged = JSON.stringify(
      [logger.debug, logger.log, logger.warn, logger.error].flatMap((method) => method.mock.calls),
    );
    expect(logged).not.toContain(ACCESS);
    expect(logged).not.toContain('Hello Ana');
  });

  describe('readMicrosoftAddress', () => {
    it('reads the mail address of the signed-in account', async () => {
      fetchMock.mockResolvedValue(Response.json({ mail: 'rivera@outlook.com', userPrincipalName: 'rivera_upn@x.com' }));
      await expect(sut.readMicrosoftAddress(ACCESS)).resolves.toBe('rivera@outlook.com');
      const [url, init] = sent();
      expect(url).toBe(GRAPH_ME_URL);
      expect(init.headers).toEqual({ Authorization: `Bearer ${ACCESS}` });
    });

    it('falls back to the sign-in name when the account has no mail address', async () => {
      fetchMock.mockResolvedValue(Response.json({ mail: null, userPrincipalName: 'rivera@contoso.com' }));
      await expect(sut.readMicrosoftAddress(ACCESS)).resolves.toBe('rivera@contoso.com');
    });

    it('refuses an answer without an address', async () => {
      fetchMock.mockResolvedValue(Response.json({ mail: null }));
      await expect(sut.readMicrosoftAddress(ACCESS)).rejects.toThrow('did not say which address signed in');
    });
  });
});
