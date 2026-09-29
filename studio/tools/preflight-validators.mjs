import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function validatePlan(plan) {
  if (plan?.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const tool = plan.tools?.[name];
    if (!path.isAbsolute(tool?.path ?? '') || !tool?.version?.trim()) {
      throw new Error(`${name} needs an absolute path and exact version line`);
    }
    const relative = path.relative(repository, tool.path);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      throw new Error(`${name} cannot be distributed inside the repository`);
    }
  }
  if (!path.isAbsolute(plan.source?.path ?? '') || !TRANSFERS.has(plan.source?.transfer)) {
    throw new Error('source needs an absolute path and HDR10 or HLG transfer');
  }
  if (!/^[a-z0-9_]+$/.test(plan.gpu?.accelerator ?? '')) {
    throw new Error('gpu accelerator is required');
  }
  if (plan.distribution !== 'local-only') throw new Error('tool distribution must be local-only');
  return plan;
}

export function validateSource(stream, transfer, frames = []) {
  const errors = [];
  if ([stream, ...frames].some((entry) => entry?.side_data_list?.some((side) =>
    /DOVI|Dolby Vision/i.test(side?.side_data_type ?? '')))) {
    errors.push('Dolby Vision source decode/reshape is unqualified; no base-layer-only policy is enabled');
  }
  if (stream?.codec_name !== 'hevc' || stream?.profile !== 'Main 10') errors.push('source is not HEVC Main 10');
  const pictures = [stream, ...frames];
  if (pictures.some((entry) => !/^yuv420p10(?:le|be)$/.test(entry?.pix_fmt ?? ''))) {
    errors.push('source or decoded frame is not 10-bit 4:2:0');
  }
  if (pictures.some((entry) => entry?.color_transfer !== transfer)) {
    errors.push(`source or decoded frame transfer is not ${transfer}`);
  }
  if (pictures.some((entry) => entry?.color_primaries !== 'bt2020' || entry?.color_space !== 'bt2020nc')) {
    errors.push('source or decoded frame is not BT.2020 signalled');
  }
  return errors;
}

export function sourceTimeline(timeBase, frames) {
  if (typeof timeBase !== 'string' || !/^[1-9]\d*\/[1-9]\d*$/.test(timeBase) ||
    !timeBase.split('/').every((part) => Number.isSafeInteger(Number(part)))) {
    throw new Error('source time base must be an exact positive rational');
  }
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('source has no frame timestamps');
  const pts = frames.map((frame) => frame?.pts);
  if (pts.some((value, index) => !Number.isSafeInteger(value) || (index > 0 && value <= pts[index - 1]))) {
    throw new Error('source PTS must be exact integers in strictly increasing presentation order');
  }
  return { timeBase, pts };
}

export function verdict(checks, attribution) {
  const portal = attribution?.resources?.find((row) => row.id === 'tool:dolby-portal');
  const portalRightsBlocked = attribution?.dolbyTools?.included !== false ||
    attribution?.dolbyTools?.access !== 'Administrator-installed portal tools only until automation/redistribution/cloud terms verified' ||
    portal?.decisions?.localRuntime !== 'blocked' || portal?.decisions?.redistribution !== 'blocked';
  const blockers = [...checks.filter((check) => !check.ok).map((check) => check.name)];
  // The repository has no reviewed local automation rights or newly analyzed edited specimen.
  blockers.push(portalRightsBlocked ? 'Dolby attribution changed; review required' : 'Dolby local automation rights unverified');
  blockers.push('edited Dolby chain and device QC absent');
  return { checks, blockers, localChecksPassed: checks.every((check) => check.ok), goNoGo: false };
}
