import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { ClientsPaymentAccount, ClientsPaymentConnectDto } from 'src/dtos/clients-payments.dto.js';
import { DatabaseLock, FrameleafWorker, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { legacyStripeEnvInUse, legacyStripeOwner } from 'src/utils/clients-payments.js';
import { getConfig } from 'src/utils/config.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { getExternalDomain } from 'src/utils/misc.js';

const BASE = '/v1/instance/clients/payments';
/** How often the server collects payment events from Frameleaf Cloud while a studio has an account connected. */
export const CLIENTS_PAYMENTS_PULL_MS = 30_000;
/** An event nothing on this server can store is acknowledged after this long, so it can't block newer ones. */
export const UNHANDLED_EVENT_LIMIT_MS = 7 * 86_400_000;

const cloudAccountSchema = z.object({
  status: z.enum(['none', 'pending', 'active', 'disconnected']),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  requirementsDue: z.array(z.string()),
  country: z.string().nullable(),
  defaultCurrency: z.string().nullable(),
});
const cloudEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  owner: z.string(),
  createdAt: z.string(),
  reference: z.string().nullable(),
  sessionId: z.string().nullable(),
  paymentIntent: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  payerEmail: z.string().nullable(),
  account: cloudAccountSchema.nullable(),
});
const cloudEventsSchema = z.object({ events: z.array(cloudEventSchema) });
const cloudLinkSchema = z.object({ url: z.string() });
const cloudCheckoutSchema = z.object({ id: z.string(), url: z.string(), expiresAt: z.string() });

/** A payment event relayed by Frameleaf Cloud; Stripe verified it there. */
export type ClientsPaymentEvent = z.infer<typeof cloudEventSchema> & { ownerId: string };
type CloudAccount = z.infer<typeof cloudAccountSchema>;
/** What this server last heard about each studio's account, keyed by user id. */
export type ClientsPaymentsState = {
  accounts: Record<
    string,
    { fingerprint: string; status: 'pending' | 'active' | 'disconnected' } & Pick<
      CloudAccount,
      'chargesEnabled' | 'requirementsDue' | 'country' | 'defaultCurrency'
    > & { updatedAt: string }
  >;
};

export type ClientsCheckout = {
  /** `<kind>:<id>`; the kind picks the handler the payment's events go to. */
  reference: string;
  idempotencyKey: string;
  name: string;
  amount: number;
  currency: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
};

/**
 * FL-1037: each studio's own Stripe account, connected through Frameleaf Cloud (Stripe Connect
 * Standard, owner decision FL-1009: direct charges, no Frameleaf fee, the studio pays Stripe's fees).
 * Payment events come back over this server's outbound link: it collects them every 30 seconds while
 * any studio has an account, hands each to the feature that made the checkout, and acknowledges it.
 */
@Injectable()
export class ClientsPaymentsService {
  private readonly handlers = new Map<string, (event: ClientsPaymentEvent) => Promise<void>>();
  private interval?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;

  constructor(
    private frameleafCloudRepository: FrameleafCloudRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ClientsPaymentsService.name);
  }

  /** A feature that creates checkouts (`order`, `link`, …) receives the payment events for its references. */
  onPayment(kind: string, handler: (event: ClientsPaymentEvent) => Promise<void>) {
    this.handlers.set(kind, handler);
  }

  private deps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  private studio(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) throw new ForbiddenException('Studio session required');
    return auth.user.id;
  }

  /** The linked instance, or null when this server isn't linked to Frameleaf Cloud. */
  private async link() {
    const { cloudUrl, link, linked } = await readCloudLink(this.deps());
    return linked && cloudUrl && link?.instanceId ? { cloudUrl, instanceId: link.instanceId } : null;
  }

  private static fingerprint(instanceId: string, ownerId: string) {
    return createHash('sha256').update(`${instanceId}${ownerId}`).digest('hex');
  }

  private async request<T extends z.ZodType>(
    schema: T,
    path: string,
    ownerId: string | null,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const link = await this.link();
    if (!link) throw new ServiceUnavailableException('Link this server to Frameleaf Cloud first');
    await loadInstanceIdentity(this.deps());
    const document = await this.frameleafCloudRepository.discovery(link.cloudUrl);
    const token = await this.frameleafCloudRepository.accessToken(
      document,
      link.instanceId,
      document.api,
      this.instanceIdentityRepository.currentSigner(),
    );
    return this.frameleafCloudRepository.requestJson(schema, {
      ...options,
      url: `${document.api.replace(/\/+$/, '')}${BASE}${path}`,
      dpop: token,
      headers: ownerId
        ? { 'X-Frameleaf-User-Fingerprint': ClientsPaymentsService.fingerprint(link.instanceId, ownerId) }
        : {},
    });
  }

  private async state(): Promise<ClientsPaymentsState> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.ClientsPayments)) ?? { accounts: {} };
  }

  /** One studio's entry, written atomically. A studio once seen keeps its entry, so its events keep routing. */
  private async remember(ownerId: string, account: CloudAccount) {
    const link = await this.link();
    if (!link) return;
    if (account.status === 'none' && !(await this.state()).accounts[ownerId]) return;
    await this.systemMetadataRepository.setEntry(SystemMetadataKey.ClientsPayments, 'accounts', ownerId, {
      fingerprint: ClientsPaymentsService.fingerprint(link.instanceId, ownerId),
      status: account.status === 'none' ? 'disconnected' : account.status,
      chargesEnabled: account.chargesEnabled,
      requirementsDue: account.requirementsDue,
      country: account.country,
      defaultCurrency: account.defaultCurrency,
      updatedAt: new Date().toISOString(),
    });
  }

  private view(account: Omit<CloudAccount, 'payoutsEnabled'> | null, ownerId: string): ClientsPaymentAccount {
    return {
      status: account?.status ?? 'none',
      chargesEnabled: account?.status !== 'disconnected' && (account?.chargesEnabled ?? false),
      requirementsDue: account?.requirementsDue ?? [],
      country: account?.country ?? null,
      defaultCurrency: account?.defaultCurrency ?? null,
      legacy: legacyStripeOwner() === ownerId,
    };
  }

  /** `GET /photography/payment-account`: asks Frameleaf Cloud, or answers what it last heard. */
  async account(auth: AuthDto): Promise<ClientsPaymentAccount> {
    const ownerId = this.studio(auth);
    if (!(await this.link())) return { ...this.view(null, ownerId), status: 'unavailable' };
    try {
      const account = await this.request(cloudAccountSchema, '/account', ownerId);
      await this.remember(ownerId, account);
      return this.view(account, ownerId);
    } catch (error) {
      this.logger.warn(`Payment account status unavailable: ${(error as Error).message}`);
      return this.view((await this.state()).accounts[ownerId] ?? null, ownerId);
    }
  }

  /** `POST /photography/payment-account/connect`: Stripe's onboarding page for this studio. */
  async connect(auth: AuthDto, dto: ClientsPaymentConnectDto) {
    const ownerId = this.studio(auth);
    try {
      const { url } = await this.request(cloudLinkSchema, '/connect', ownerId, {
        method: 'POST',
        body: { returnUrl: dto.returnUrl, refreshUrl: dto.returnUrl },
      });
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('stripe.com'))
        throw new ServiceUnavailableException('Unexpected payment account link');
      const state = await this.state();
      if (!state.accounts[ownerId])
        await this.remember(ownerId, { ...this.view(null, ownerId), status: 'pending', payoutsEnabled: false });
      return { url };
    } catch (error) {
      if (error instanceof FrameleafCloudError && error.status === 402)
        throw new ForbiddenException('Taking payments needs a Server licence on this server');
      throw error;
    }
  }

  /** `DELETE /photography/payment-account`: no new payments for this studio; its Stripe account stays its own. */
  async disconnect(auth: AuthDto): Promise<ClientsPaymentAccount> {
    const ownerId = this.studio(auth);
    const account = await this.request(cloudAccountSchema, '/account', ownerId, { method: 'DELETE' });
    await this.remember(ownerId, account);
    return this.view(account, ownerId);
  }

  /** Whether this studio can take a payment through its connected account now (no network call). */
  async ready(ownerId: string) {
    const account = (await this.state()).accounts[ownerId];
    return !!account && account.status === 'active' && account.chargesEnabled;
  }

  /** The server's public address, for pages Stripe sends a payer back to; null when none is set. */
  async publicUrl() {
    const { server } = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    return getExternalDomain(server)?.replace(/\/+$/, '') ?? null;
  }

  /** A Stripe Checkout page on the studio's own account. */
  checkout(ownerId: string, checkout: ClientsCheckout) {
    return this.request(cloudCheckoutSchema, '/checkout', ownerId, { method: 'POST', body: checkout });
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    if (legacyStripeEnvInUse())
      this.logger.warn(
        'PHOTOGRAPHY_STRIPE_* and PHOTOGRAPHY_CHECKOUT_* are deprecated: rename them FRAMELEAF_CLIENTS_*, or connect the studio account in Clients > Payments. They will be removed in the next release.',
      );
    this.stopping = false;
    this.interval ??= setInterval(() => void this.tick(), CLIENTS_PAYMENTS_PULL_MS);
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.interval);
    this.interval = undefined;
    await this.active;
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return (this.active ??= this.databaseRepository
      .withLock(DatabaseLock.ClientsPaymentEvents, () => this.collect())
      .catch((error) => this.logger.warn(`Payment events unavailable: ${(error as Error).message}`))
      .finally(() => {
        this.active = undefined;
      }));
  }

  /** Collects waiting events, handles each, and acknowledges the ones handled. A failed one comes back next time. */
  async collect() {
    const state = await this.state();
    if (Object.keys(state.accounts).length === 0 || !(await this.link())) return;
    const owners = new Map(Object.entries(state.accounts).map(([ownerId, a]) => [a.fingerprint, ownerId]));
    const { events } = await this.request(cloudEventsSchema, '/events', null);
    const handled: string[] = [];
    for (const event of events) {
      const ownerId = owners.get(event.owner);
      try {
        // Acknowledged only once something stored it; anything else comes back on the next collection. Cloud
        // sends the oldest 50 waiting events, so one nothing here can ever store is let go after a week, or it
        // would hold back newer payments.
        if (ownerId && (await this.handle({ ...event, ownerId }))) handled.push(event.id);
        else if (Date.now() - Date.parse(event.createdAt) > UNHANDLED_EVENT_LIMIT_MS) {
          this.logger.warn(`Payment event ${event.id} (${event.type}) had no handler for a week; letting it go`);
          handled.push(event.id);
        }
      } catch (error) {
        this.logger.warn(`Payment event ${event.id} left for the next collection: ${(error as Error).message}`);
      }
    }
    if (handled.length > 0)
      await this.request(z.unknown(), '/events/ack', null, { method: 'POST', body: { ids: handled } });
  }

  /** True once the event was stored: an account change, or a feature's handler for its reference. */
  private async handle(event: ClientsPaymentEvent) {
    if (event.account) {
      await this.remember(event.ownerId, event.account);
      return true;
    }
    const kind = event.reference?.split(':', 1)[0];
    const handler = kind ? this.handlers.get(kind) : undefined;
    if (!handler) return false;
    await handler(event);
    return true;
  }
}
