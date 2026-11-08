import { join, parse } from 'node:path';

/**
 * FL-968: DJI drones write a `.SRT` subtitle file next to each video, with one entry per frame that
 * includes the aircraft's position. Videos from some models carry no GPS of their own, so the first
 * entry with a fix is used as the video's location.
 *
 * Two layouts are in use:
 * - newer models: `[latitude: 47.123456] [longitude: 8.123456]` (the Mavic Air 2 spells it `longtitude`)
 * - older models (Phantom 4, Mavic Pro): `GPS(8.123456,47.123456,19)`, longitude first
 */

/** Enough for the first few dozen entries; a long flight's file runs to megabytes. */
export const DJI_SRT_READ_BYTES = 16 * 1024;

export const getDjiSrtCandidates = (originalPath: string) => {
  const { dir, name } = parse(originalPath);
  return [`${join(dir, name)}.SRT`, `${join(dir, name)}.srt`];
};

const NUMBER = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
const BRACKETED = new RegExp(
  String.raw`\[\s*latitude\s*:\s*${NUMBER}\s*\]\s*\[\s*long?t?itude\s*:\s*${NUMBER}\s*\]`,
  'gi',
);
const LEGACY = new RegExp(String.raw`GPS\s*\(\s*${NUMBER}\s*,\s*${NUMBER}\s*(?:,[^)]*)?\)`, 'gi');

const valid = (latitude: number, longitude: number) =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  Math.abs(latitude) <= 90 &&
  Math.abs(longitude) <= 180 &&
  // A drone without a satellite fix writes zeros.
  (latitude !== 0 || longitude !== 0);

/** The first position with a fix in a DJI telemetry subtitle file, or null. */
export const parseDjiSrtLocation = (text: string): { latitude: number; longitude: number } | null => {
  const found = [
    ...Array.from(text.matchAll(BRACKETED), (match) => ({
      at: match.index,
      latitude: Number(match[1]),
      longitude: Number(match[2]),
    })),
    ...Array.from(text.matchAll(LEGACY), (match) => ({
      at: match.index,
      latitude: Number(match[2]),
      longitude: Number(match[1]),
    })),
  ];
  const first = found.filter(({ latitude, longitude }) => valid(latitude, longitude)).sort((a, b) => a.at - b.at)[0];
  return first ? { latitude: first.latitude, longitude: first.longitude } : null;
};
