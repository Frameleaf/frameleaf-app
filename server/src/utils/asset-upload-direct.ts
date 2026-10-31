import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import z from 'zod';

export const DIRECT_UPLOAD_LIMITS = {
  peers: 16,
  peersPerOwner: 2,
  negotiationMs: 10_000,
  idleMs: 30_000,
  lifetimeMs: 5 * 60_000,
  sdpBytes: 65_536,
  controlBytes: 1024,
  frameBytes: 65_536,
  appendBytes: 4 * 1024 * 1024,
} as const;
export const DIRECT_UPLOAD_CHANNEL = 'frameleaf-upload-v1';

export const DirectUploadDescriptionSchema = z.strictObject({
  version: z.number().int().min(1).max(1),
  sdp: z.string().min(1).max(DIRECT_UPLOAD_LIMITS.sdpBytes),
});

const appendSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal('append'),
  requestId: z.uuid(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().min(0).max(DIRECT_UPLOAD_LIMITS.appendBytes),
  complete: z.boolean(),
});
export type DirectAppend = z.infer<typeof appendSchema>;

export function parseDirectAppend(message: string, maxAppendSize: number): DirectAppend {
  if (Buffer.byteLength(message) > DIRECT_UPLOAD_LIMITS.controlBytes) {
    throw new BadRequestException('Invalid direct upload control');
  }
  try {
    const append = appendSchema.parse(JSON.parse(message));
    if (
      append.length > maxAppendSize ||
      (append.length === 0 && !append.complete) ||
      !Number.isSafeInteger(append.offset + append.length)
    ) {
      throw new Error('Invalid append length');
    }
    return append;
  } catch {
    throw new BadRequestException('Invalid direct upload control');
  }
}

export function validateDirectOffer(input: unknown): z.infer<typeof DirectUploadDescriptionSchema> {
  const parsed = DirectUploadDescriptionSchema.safeParse(input);
  const invalid = () => {
    throw new BadRequestException('Invalid direct upload offer');
  };
  if (!parsed.success) return invalid();
  const { sdp } = parsed.data;
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  const media = lines.filter((line) => line.startsWith('m='));
  const candidates = lines.filter((line) => line.startsWith('a=candidate:'));
  if (
    Buffer.byteLength(sdp) > DIRECT_UPLOAD_LIMITS.sdpBytes ||
    lines[0] !== 'v=0' ||
    media.length !== 1 ||
    !/^m=application [1-9]\d* UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]) ||
    !lines.includes('a=end-of-candidates') ||
    candidates.length > 64 ||
    lines.every((line) => !/^a=fingerprint:sha-256 (?:[a-f\d]{2}:){31}[a-f\d]{2}$/i.test(line)) ||
    lines.every((line) => !/^a=ice-ufrag:[\w+/]{4,256}$/.test(line)) ||
    lines.every((line) => !/^a=ice-pwd:[\w+/]{22,256}$/.test(line)) ||
    !lines.includes('a=setup:actpass') ||
    lines.every((line) => !/^a=sctp-port:\d+$/.test(line))
  )
    return invalid();
  for (const line of candidates) {
    const fields = line.split(' ');
    if (
      fields[2]?.toLowerCase() !== 'udp' ||
      fields[1] !== '1' ||
      !isIP(fields[4]) ||
      !/^[1-9]\d*$/.test(fields[5]) ||
      Number(fields[5]) > 65_535 ||
      fields[6] !== 'typ' ||
      !['host', 'srflx', 'prflx'].includes(fields[7])
    )
      return invalid();
  }
  return parsed.data;
}
