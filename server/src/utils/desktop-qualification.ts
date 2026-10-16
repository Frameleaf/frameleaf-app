import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from 'zod';
import type { verifyDesktopRuntimeAttestation } from 'src/utils/desktop-runtime-attestation.js';
import { type DesktopModelProfile, createDesktopModelChallenge } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

export type DesktopRuntimeIdentity = ReturnType<typeof verifyDesktopRuntimeAttestation>;
type Challenge = ReturnType<typeof createDesktopModelChallenge>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const label = z.string().max(256);
const factsSchema = z.strictObject({
  system: z.enum(['Darwin', 'Linux', 'Windows']),
  release: label,
  architecture: z.enum(['arm64', 'aarch64', 'x86_64', 'AMD64']),
  processor: label,
  python: label,
  ort: label,
  packages: z
    .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(64))
    .refine((value) => Object.keys(value).length <= 16),
  providers: z.array(z.string().min(1).max(64)).min(1).max(32),
  gpus: z
    .array(
      z.strictObject({
        index: z.string().max(8),
        identitySha256: digest,
        driver: z.string().max(64),
        memoryBytes: integer.positive(),
      }),
    )
    .max(64),
  totalMemoryBytes: integer.positive(),
});
const state = z.enum(['ready-cpu', 'ready-accelerator', 'ready-mixed']);
const reportSchema = z.strictObject({
  protocolVersion: z.literal(1),
  modelKey: z.string().max(256),
  provider: z.string().max(64),
  preprocessingSha256: digest,
  fixtureSha256: digest,
  bindingSha256: digest,
  runtimeFingerprint: digest,
  runtime: factsSchema,
  coldMilliseconds: z.number().min(0).max(600_000),
  warmMilliseconds: z.number().min(0).max(600_000),
  reason: z.null(),
  state,
  execution: z
    .array(
      z.strictObject({
        state,
        reason: z.null(),
        nodes: z.record(z.string().max(64), integer.positive().max(200_000)),
        microseconds: z.record(z.string().max(64), z.number().min(0).max(Number.MAX_SAFE_INTEGER)),
      }),
    )
    .min(1)
    .max(64),
});
const profilesSchema = z.object({
  profiles: z.record(z.string(), z.object({ python: z.string(), provider: z.string(), targets: z.array(z.string()) })),
});

/** A sealed, validated receipt; recording it does not authorize a model grant. */
export class DesktopQualificationReceipt {
  private constructor(
    readonly reportSha256: string,
    readonly runtimeFingerprint: string,
    readonly bindingSha256: string,
    readonly manifestSha256: string,
    readonly modelKey: string,
    readonly profileSha256: string,
  ) {
    Object.freeze(this);
  }

  static validate(
    value: unknown,
    profile: DesktopModelProfile,
    challenge: Challenge,
    runtime: DesktopRuntimeIdentity,
  ): DesktopQualificationReceipt {
    const invalid = () => new Error('desktop_qualification_invalid');
    const report = reportSchema.parse(value);
    const spec: unknown = JSON.parse(challenge.specJson);
    const filename = z.object({ fixtureFile: z.string() }).parse(spec).fixtureFile;
    const expected = createDesktopModelChallenge(profile, filename.slice(0, 36));
    if (
      canonicalJson(expected) !== canonicalJson(challenge) ||
      runtime.sourceRevision !== profile.runtimeSourceRevision ||
      runtime.provider !== profile.spec.provider ||
      !/^[a-f0-9]{64}$/.test(runtime.manifestSha256) ||
      report.bindingSha256 !== challenge.bindingSha256 ||
      report.modelKey !== profile.modelKey ||
      report.provider !== profile.spec.provider ||
      report.preprocessingSha256 !== profile.spec.preprocessingSha256 ||
      report.fixtureSha256 !== profile.spec.fixtureSha256 ||
      report.execution.length !== profile.spec.models.length ||
      report.coldMilliseconds + report.warmMilliseconds > profile.spec.deadlineSeconds * 1000
    )
      throw invalid();
    const facts = report.runtime;
    // Python's stable-fact encoder sorts keys and escapes non-ASCII UTF-16 code units.
    // Python escapes UTF-16 code units, including DEL and each surrogate separately.
    const encoded = canonicalJson(facts).replaceAll(
      // eslint-disable-next-line unicorn/prefer-unicode-code-point-escapes
      /[\u007F-\uFFFF]/g,
      (character) => String.raw`\u` + character.codePointAt(0)!.toString(16).padStart(4, '0'),
    );
    const platform = { Darwin: 'macos', Linux: 'linux', Windows: 'windows' }[facts.system];
    const architecture = { arm64: 'aarch64', aarch64: 'aarch64', x86_64: 'x86_64', AMD64: 'x86_64' }[
      facts.architecture
    ];
    const approved = profilesSchema.parse(
      JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/runtime-profiles.json'), 'utf8')),
    ).profiles;
    if (
      sha(encoded) !== report.runtimeFingerprint ||
      platform !== runtime.platform ||
      architecture !== runtime.architecture ||
      facts.totalMemoryBytes < profile.spec.minMemoryBytes ||
      canonicalJson([...new Set(facts.providers)].sort()) !== canonicalJson(facts.providers) ||
      !facts.providers.includes(report.provider) ||
      Object.values(approved).every(
        (item) =>
          !(
            item.provider === runtime.provider &&
            item.python === facts.python &&
            item.targets.includes(`${platform}-${architecture}`)
          ),
      ) ||
      ![facts.packages.onnxruntime, facts.packages['onnxruntime-gpu']].includes(facts.ort)
    )
      throw invalid();
    const provider = report.provider;
    if (!['CPUExecutionProvider', 'CUDAExecutionProvider'].includes(provider)) throw invalid();
    let mixed = false;
    for (const execution of report.execution) {
      const providers = Object.keys(execution.nodes).sort();
      if (
        !execution.nodes[provider] ||
        providers.some((name) => name !== provider && name !== 'CPUExecutionProvider') ||
        canonicalJson(Object.keys(execution.microseconds).sort()) !== canonicalJson(providers)
      )
        throw invalid();
      const itemState =
        provider === 'CPUExecutionProvider'
          ? 'ready-cpu'
          : execution.nodes.CPUExecutionProvider
            ? 'ready-mixed'
            : 'ready-accelerator';
      if (execution.state !== itemState) throw invalid();
      mixed ||= itemState === 'ready-mixed';
    }
    const expectedState =
      provider === 'CPUExecutionProvider' ? 'ready-cpu' : mixed ? 'ready-mixed' : 'ready-accelerator';
    if (report.state !== expectedState || (provider === 'CUDAExecutionProvider' && facts.gpus.length === 0))
      throw invalid();
    return new DesktopQualificationReceipt(
      sha(canonicalJson(report)),
      report.runtimeFingerprint,
      report.bindingSha256,
      runtime.manifestSha256,
      profile.modelKey,
      sha(canonicalJson(profile)),
    );
  }
}
