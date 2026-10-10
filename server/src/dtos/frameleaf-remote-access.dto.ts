import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Remote access through Frameleaf Cloud (FL-165): what Settings › Frameleaf Cloud › Remote access
 * shows and changes, and the connection candidates apps race. Customer copy says "Frameleaf Cloud";
 * no key, secret or token ever appears in a response.
 */

export const RemoteAccessModeSchema = z
  .enum(['relay', 'relay-and-direct'])
  .describe('relay: every remote connection goes through the relay; relay-and-direct: direct connections too')
  .meta({ id: 'RemoteAccessMode' });

export const RemoteAccessPublicUrlSchema = z
  .enum(['frameleaf', 'custom'])
  .describe('The published address: the Frameleaf address, or the verified custom hostname')
  .meta({ id: 'RemoteAccessPublicUrl' });

export const RemoteHostnameStatusSchema = z
  .enum(['pending', 'verified'])
  .describe('pending: waiting for its DNS records; verified: Frameleaf Cloud verified them')
  .meta({ id: 'RemoteHostnameStatus' });

const RemoteAccessStateSchema = z
  .enum(['off', 'idle', 'starting', 'ready', 'error', 'unknown'])
  .describe('What the edge worker is doing; unknown when no edge worker reported recently')
  .meta({ id: 'RemoteAccessState' });

const RemoteConnectionKindSchema = z
  .enum(['local', 'wan', 'relay', 'ipv6'])
  .describe('local, wan (a custom hostname too), ipv6 or relay')
  .meta({ id: 'RemoteConnectionKind' });

const RemoteConnectionProtocolSchema = z.enum(['http', 'https']).meta({ id: 'RemoteConnectionProtocol' });

const RemoteMappingMethodSchema = z
  .enum(['upnp', 'nat-pmp', 'manual'])
  .describe('How the direct port is opened: by the router (UPnP, NAT-PMP) or forwarded by hand')
  .meta({ id: 'RemoteMappingMethod' });

const RemoteDirectGuidanceSchema = z
  .enum(['bridge'])
  .describe('bridge: running in a container whose network cannot reach the router')
  .meta({ id: 'RemoteDirectGuidance' });

const RemoteDnsRecordTypeSchema = z.enum(['CNAME']).meta({ id: 'RemoteDnsRecordType' });

export const RemoteConnectionSchema = z
  .object({
    kind: RemoteConnectionKindSchema,
    uri: z.string().describe('The address to connect to, https only'),
    protocol: RemoteConnectionProtocolSchema,
    address: z.string().describe('Host name or address, without brackets for IPv6'),
    port: z.int(),
    local: z.boolean(),
    relay: z.boolean().describe('Carried by the Frameleaf relay'),
    ipv6: z.boolean(),
    custom: z.boolean().describe('The administrator’s own hostname, verified by Frameleaf Cloud'),
    dnsRebindingProtection: z.boolean().describe('The server refuses requests for another Host'),
    httpsRequired: z.boolean(),
    verified: z.boolean().describe('Frameleaf Cloud verified this entry itself'),
  })
  .describe('One way to reach this server, in the order apps should try them')
  .meta({ id: 'RemoteConnectionDto' });

const RemoteConnectionsResponseSchema = z
  .object({
    instanceId: z.string().nullable().describe('This server’s Frameleaf instance ID while it is linked'),
    publicUrl: z.string().nullable().describe('The address this server publishes for remote access'),
    connections: z.array(RemoteConnectionSchema).describe('Ordered local, wan, ipv6, custom hostname, relay'),
  })
  .meta({ id: 'RemoteConnectionsResponseDto' });

const RemoteDnsRecordSchema = z
  .object({
    type: RemoteDnsRecordTypeSchema,
    name: z.string(),
    value: z.string(),
    purpose: z.string().describe('What the record is for, in plain words'),
  })
  .meta({ id: 'RemoteDnsRecordDto' });

const RemoteAccessTestCheckSchema = z
  .object({
    id: z.string().describe('certificate, listener, api, relay or direct'),
    ok: z.boolean(),
    detail: z.string(),
  })
  .meta({ id: 'RemoteAccessTestCheckDto' });

const RemoteAccessStatusResponseSchema = z
  .object({
    unavailableReason: z
      .string()
      .nullable()
      .describe('Why remote access cannot be turned on (not set up, not linked, no plan); null when it can'),
    enabled: z.boolean().describe('Remote access is switched on'),
    mode: RemoteAccessModeSchema,
    directPort: z.int().describe('External port for direct connections'),
    portMapping: z.boolean().describe('The router is asked to open the direct port automatically'),
    publicUrlChoice: RemoteAccessPublicUrlSchema,
    status: RemoteAccessStateSchema,
    reason: z.string().nullable().describe('Why it is off, idle or failing, in plain words'),
    publicUrl: z.string().nullable().describe('The address this server publishes'),
    frameleafAddress: z.string().nullable().describe('https://r.<label>.<direct domain>, once enrolled'),
    certificateName: z.string().nullable().describe('The wildcard name the certificate covers'),
    certificateExpiresAt: z.string().nullable(),
    certificateError: z.string().nullable().describe('The last issuance or renewal problem'),
    relayConnected: z.boolean(),
    relayRegion: z.string().nullable().describe('The relay this server uses (eu1, us1)'),
    relayLatencyMs: z.int().nullable().describe('Round trip to the relay, from its last keepalive'),
    relayConnectedAt: z.string().nullable().describe('When the current relay connection was made'),
    relayBytesIn: z.int().describe('Bytes received through the relay since the edge worker started'),
    relayBytesOut: z.int().describe('Bytes sent through the relay since the edge worker started'),
    relayLastError: z.string().nullable().describe('The last relay problem, in plain words'),
    relayLastErrorAt: z.string().nullable(),
    relayRevoked: z
      .boolean()
      .describe('Frameleaf Cloud stopped the relay for this server; it is tried again once relinked'),
    directListening: z.boolean(),
    cgnatSuspected: z.boolean(),
    mappingMethod: RemoteMappingMethodSchema.nullable().describe(
      'How the direct port is open right now; null when it is not',
    ),
    mappingError: z.string().nullable().describe('Why the router did not open the direct port'),
    directGuidance: RemoteDirectGuidanceSchema.nullable(),
    directExternalIp: z.string().nullable().describe('The public address direct connections reach'),
    wanAddress: z.string().nullable().describe('The direct address Frameleaf Cloud tested'),
    wanVerified: z.boolean().describe('Frameleaf Cloud reached this server directly at wanAddress'),
    wanProblem: z
      .string()
      .nullable()
      .describe('Why Frameleaf Cloud could not reach it: unreachable, timeout, certificate or not_public'),
    customHostname: z.string().nullable().describe('The custom hostname, when one was added'),
    customHostnameStatus: RemoteHostnameStatusSchema.nullable(),
    customHostnameCheckedAt: z.string().nullable(),
    customHostnameProblem: z.string().nullable().describe('Why the hostname is not verified yet'),
    customHostnameRecords: z
      .array(RemoteDnsRecordSchema)
      .describe('The two records to add at the DNS provider; empty until enrolled'),
    candidates: z.array(RemoteConnectionSchema),
    lastTestAt: z.string().nullable(),
    lastTestOk: z.boolean().nullable(),
    lastTestChecks: z.array(RemoteAccessTestCheckSchema),
  })
  .meta({ id: 'RemoteAccessStatusResponseDto' });

const RemoteAccessUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Turn remote access on or off'),
    mode: RemoteAccessModeSchema.optional(),
    directPort: z.int().min(1024).max(65_535).optional().describe('External port for direct connections'),
    portMapping: z.boolean().optional().describe('Ask the router to open the direct port automatically'),
    publicUrl: RemoteAccessPublicUrlSchema.optional(),
  })
  .meta({ id: 'RemoteAccessUpdateDto' });

const RemoteHostnameUpdateSchema = z
  .object({
    hostname: z.string().min(1).max(254).describe('A subdomain of a domain you own, such as photos.example.com'),
  })
  .meta({ id: 'RemoteHostnameUpdateDto' });

const RemoteAccessUsageResponseSchema = z
  .object({
    period: z.string().describe('The month, YYYY-MM (UTC)'),
    periodStart: z.string(),
    periodEnd: z.string(),
    bytes: z.int().describe('Bytes through the relay this month, in and out, custom hostnames included'),
    limitBytes: z.int().describe('The relay allowance the plan includes each month'),
    throttled: z.boolean().describe('The allowance is used up: the relay is slowed down, never cut off'),
    throttleBps: z.int().nullable().describe('The slowed-down speed in bits per second, while throttled'),
    throttleUntil: z.string().nullable().describe('When the slowdown lifts, while throttled'),
  })
  .meta({ id: 'RemoteAccessUsageResponseDto' });

export class RemoteConnectionsResponseDto extends createZodDto(RemoteConnectionsResponseSchema) {}
export class RemoteAccessUsageResponseDto extends createZodDto(RemoteAccessUsageResponseSchema) {}
export class RemoteAccessStatusResponseDto extends createZodDto(RemoteAccessStatusResponseSchema) {}
export class RemoteAccessUpdateDto extends createZodDto(RemoteAccessUpdateSchema) {}
export class RemoteHostnameUpdateDto extends createZodDto(RemoteHostnameUpdateSchema) {}
