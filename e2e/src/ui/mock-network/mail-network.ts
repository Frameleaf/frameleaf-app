import { BrowserContext } from '@playwright/test';
import { adminConfigDefaults } from 'src/ui/mock-network/admin-config.js';

/**
 * Mocked mail account routes (FL-379), alongside `base-network.ts`: the admin API this server
 * exposes under `admin/notifications/mail-connection`, scripted through `state`, and the saved
 * email settings that go with it. Google, Microsoft and Frameleaf Cloud are never used: the
 * "provider page" a sign-in opens is a page this mock serves.
 */
export type MailMockConnection = {
  provider: 'gmail' | 'microsoft';
  email: string;
  status: 'connected' | 'needs-sign-in';
  connectedAt: string;
  needsSignInSince?: string;
};

export type MailMockState = {
  available: boolean;
  unavailableReason?: 'not-configured' | 'not-linked' | 'cloud-unreachable';
  providers: Array<'gmail' | 'microsoft'>;
  connection: MailMockConnection | null;
  /** How email is saved to be sent, and whether sending is on. */
  transport: 'smtp' | 'gmail' | 'microsoft';
  enabled: boolean;
  /** A sign-in in progress: the next `complete` connects this account. */
  finishing?: MailMockConnection;
  /** How many times `complete` answers `pending` first. */
  pendingAnswers?: number;
  /** What the test email answers; a string is the server's reason for refusing. */
  testEmail?: 'sent' | string;
  requests: Array<{ method: string; path: string; body?: unknown }>;
};

/** The path of the stand-in for the provider's sign-in page. */
export const MAIL_PROVIDER_PAGE = '/__mail-provider-page';

export const mailMockState = (overrides: Partial<MailMockState> = {}): MailMockState => ({
  available: true,
  providers: ['gmail', 'microsoft'],
  connection: null,
  transport: 'smtp',
  enabled: false,
  requests: [],
  ...overrides,
});

const savedConfig = (mock: MailMockState) => ({
  ...adminConfigDefaults,
  notifications: {
    ...adminConfigDefaults.notifications,
    smtp: {
      ...adminConfigDefaults.notifications.smtp,
      enabled: mock.enabled,
      transport: { ...adminConfigDefaults.notifications.smtp.transport, type: mock.transport },
    },
  },
});

export const setupMailMockApiRoutes = async (context: BrowserContext, mock: MailMockState) => {
  const record = (method: string, path: string, body?: unknown) => {
    mock.requests.push({ method, path, body });
  };

  await context.route('**/api/admin/config/revision', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: { config: savedConfig(mock), revision: `mail-${mock.transport}-${mock.enabled}` },
        })
      : route.fallback(),
  );
  await context.route('**/api/system-config', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: savedConfig(mock) }) : route.fallback(),
  );
  await context.route(`**${MAIL_PROVIDER_PAGE}*`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Provider sign-in</title><p>Provider sign-in page</p>' }),
  );

  await context.route('**/api/admin/notifications/mail-connection', (route) => {
    const method = route.request().method();
    record(method, 'mail-connection');
    if (method === 'DELETE') {
      const provider = mock.connection?.provider ?? 'gmail';
      mock.connection = null;
      mock.transport = 'smtp';
      mock.enabled = false;
      // Microsoft offers no revocation; the server says so
      return route.fulfill({ json: { provider, revoked: provider === 'gmail' } });
    }
    return route.fulfill({
      json: {
        available: mock.available,
        ...(mock.unavailableReason && { unavailableReason: mock.unavailableReason }),
        providers: mock.providers,
        connection: mock.connection,
        signIn: mock.finishing ? 'pending' : 'none',
        ...(mock.finishing && { signInProvider: mock.finishing.provider }),
      },
    });
  });
  await context.route('**/api/admin/notifications/mail-connection/start', (route) => {
    const body = route.request().postDataJSON() as { provider: 'gmail' | 'microsoft' };
    record('POST', 'mail-connection/start', body);
    mock.finishing = {
      provider: body.provider,
      email: body.provider === 'gmail' ? 'rivera.family@gmail.com' : 'rivera.family@outlook.com',
      status: 'connected',
      connectedAt: '2026-10-11T10:00:00.000Z',
    };
    const origin = new URL(route.request().url()).origin;
    return route.fulfill({
      json: {
        authorizationUrl: `${origin}${MAIL_PROVIDER_PAGE}?service=${body.provider}`,
        expiresAt: '2026-10-11T10:10:00.000Z',
      },
    });
  });
  await context.route('**/api/admin/notifications/mail-connection/complete', (route) => {
    record('POST', 'mail-connection/complete');
    if (!mock.finishing) {
      return route.fulfill({ json: { state: 'none', connection: null } });
    }
    if ((mock.pendingAnswers ?? 0) > 0) {
      mock.pendingAnswers = (mock.pendingAnswers ?? 0) - 1;
      return route.fulfill({ json: { state: 'pending', connection: null } });
    }
    // as the server does: keep the account, point email at it and switch sending on
    mock.connection = mock.finishing;
    mock.transport = mock.finishing.provider;
    mock.enabled = true;
    mock.finishing = undefined;
    return route.fulfill({ json: { state: 'connected', connection: mock.connection } });
  });
  await context.route('**/api/admin/notifications/test-email', (route) => {
    record('POST', 'test-email', route.request().postDataJSON());
    return !mock.testEmail || mock.testEmail === 'sent'
      ? route.fulfill({ json: { messageId: '<fixture@frameleaf>' } })
      : route.fulfill({ status: 400, json: { message: mock.testEmail, error: 'Bad Request', statusCode: 400 } });
  });
};
