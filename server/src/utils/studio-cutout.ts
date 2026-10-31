import { BadRequestException } from '@nestjs/common';
import { toApproximateNumber } from 'src/utils/rational-time.js';
import { TranscriptionClip, transcriptionWindow } from 'src/utils/studio-transcription.js';

/**
 * FL-639: the pure half of "Cut out the subject".
 *
 * A cut-out reads the part of a video clip's source that the clip plays, a few frames a second, and the
 * ML worker follows the subject through them (SAM2.1 video). The mattes come back one small grayscale
 * frame each and are kept with the project as one PNG: the frames side by side, row after row (an
 * atlas). The editor's compositor draws the matte of the frame nearest each moment under the clip, so
 * preview and export use the same file.
 */

/** At most this many frames are followed; a long clip is read less often. */
export const CUTOUT_MAX_FRAMES = 300;
/** Frames a second for a short clip. */
export const CUTOUT_MAX_FPS = 10;
/** A clip longer than this is too long to follow at one frame a second. */
export const CUTOUT_MAX_SECONDS = CUTOUT_MAX_FRAMES;
/** The long edge of the frames the worker reads. */
export const CUTOUT_FRAME_EDGE = 640;
/** The long edge of each matte frame kept with the project. */
export const CUTOUT_MATTE_EDGE = 192;
/** The widest the atlas may be, so every browser can decode it. */
export const CUTOUT_ATLAS_MAX_WIDTH = 8192;

export type CutoutPlan = {
  /** Where the followed window starts in the source, in seconds. */
  startSeconds: number;
  durationSeconds: number;
  /** Frames a second read from the window. */
  fps: number;
  frames: number;
  /** The frames sent to the worker. */
  frameWidth: number;
  frameHeight: number;
  /** Each matte frame in the atlas. */
  matteWidth: number;
  matteHeight: number;
  columns: number;
  rows: number;
};

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** A size with `edge` on its long side and the source's shape. */
export const fitEdge = (width: number, height: number, edge: number) => {
  if (!(width > 0 && height > 0)) {
    throw new BadRequestException("The clip's picture size is unknown");
  }
  const scale = edge / Math.max(width, height);
  return { width: even(width * scale), height: even(height * scale) };
};

/** How a clip is read and how its mattes are laid out. */
export const cutoutPlan = (
  clip: Pick<TranscriptionClip, 'durationInFrames' | 'cadence' | 'speed' | 'sourceStart'>,
  source: { width: number; height: number },
): CutoutPlan => {
  const window = transcriptionWindow(clip as TranscriptionClip);
  const startSeconds = toApproximateNumber(window.start);
  const durationSeconds = toApproximateNumber(window.duration);
  if (!(durationSeconds > 0)) {
    throw new BadRequestException('The clip is empty');
  }
  if (durationSeconds > CUTOUT_MAX_SECONDS) {
    throw new BadRequestException(`Cut out the subject works on clips up to ${CUTOUT_MAX_SECONDS / 60} minutes long`);
  }
  const fps = Math.min(CUTOUT_MAX_FPS, CUTOUT_MAX_FRAMES / durationSeconds);
  const frames = Math.max(1, Math.min(CUTOUT_MAX_FRAMES, Math.ceil(durationSeconds * fps - 1e-6)));
  const frame = fitEdge(source.width, source.height, CUTOUT_FRAME_EDGE);
  const matte = fitEdge(source.width, source.height, CUTOUT_MATTE_EDGE);
  const columns = Math.max(1, Math.min(frames, Math.floor(CUTOUT_ATLAS_MAX_WIDTH / matte.width)));
  return {
    startSeconds,
    durationSeconds,
    fps,
    frames,
    frameWidth: frame.width,
    frameHeight: frame.height,
    matteWidth: matte.width,
    matteHeight: matte.height,
    columns,
    rows: Math.ceil(frames / columns),
  };
};

/** Where matte frame `index` sits in the atlas. */
export const atlasCell = (plan: Pick<CutoutPlan, 'columns' | 'matteWidth' | 'matteHeight'>, index: number) => ({
  left: (index % plan.columns) * plan.matteWidth,
  top: Math.floor(index / plan.columns) * plan.matteHeight,
});

export type CutoutPoint = { sourceSeconds: number; x: number; y: number; label: 0 | 1 };

/** "Add to subject" and "Take away" points as the worker reads them: a frame of the window and fractions of it. */
export const workerPoints = (plan: CutoutPlan, points: readonly CutoutPoint[]) =>
  points.flatMap((point) => {
    const frame = Math.round((point.sourceSeconds - plan.startSeconds) * plan.fps);
    return frame >= 0 && frame < plan.frames ? [{ frame, x: point.x, y: point.y, label: point.label }] : [];
  });

export type CutoutFace = {
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
};

/** A face box from face recognition as fractions of the picture, or null when it cannot be read. */
export const faceFraction = (face: CutoutFace): [number, number, number, number] | null => {
  const { imageWidth: width, imageHeight: height } = face;
  if (!(width > 0 && height > 0)) {
    return null;
  }
  const box = [
    face.boundingBoxX1 / width,
    face.boundingBoxY1 / height,
    face.boundingBoxX2 / width,
    face.boundingBoxY2 / height,
  ].map((value) => Math.max(0, Math.min(1, value))) as [number, number, number, number];
  return box[0] < box[2] && box[1] < box[3] ? box : null;
};

/** How long one cut-out may take: two minutes to start, then ten seconds a frame (CPU), at most an hour. */
export const cutoutDeadlineMs = (frames: number) => Math.min(60 * 60_000, 120_000 + frames * 10_000);

const parseEmbedding = (value: string | null): number[] | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'number') ? parsed : null;
  } catch {
    return null;
  }
};

const cosine = (a: number[], b: number[]) => {
  const length = Math.min(a.length, b.length);
  const dot = a.slice(0, length).reduce((sum, value, index) => sum + value * b[index], 0);
  const left = a.slice(0, length).reduce((sum, value) => sum + value * value, 0);
  const right = b.slice(0, length).reduce((sum, value) => sum + value * value, 0);
  return left > 0 && right > 0 ? dot / Math.sqrt(left * right) : 0;
};

/** Below this similarity a face found on the first frame is someone else. */
export const CUTOUT_FACE_MATCH = 0.5;

/**
 * The chosen person's face among those found on a clip's first frame, as fractions of that frame. With
 * their library face's embedding: the most similar face, if similar enough. Without one: the face whose
 * centre is nearest the library box. Null when no face matches.
 */
export const matchFirstFrameFace = (
  detected: {
    imageWidth: number;
    imageHeight: number;
    faces: Array<{ boundingBox: { x1: number; y1: number; x2: number; y2: number }; embedding: string }>;
  },
  libraryBox: [number, number, number, number],
  libraryEmbedding: string | null,
): [number, number, number, number] | null => {
  const reference = parseEmbedding(libraryEmbedding);
  const candidates = detected.faces.flatMap((face) => {
    const box = faceFraction({
      boundingBoxX1: face.boundingBox.x1,
      boundingBoxY1: face.boundingBox.y1,
      boundingBoxX2: face.boundingBox.x2,
      boundingBoxY2: face.boundingBox.y2,
      imageWidth: detected.imageWidth,
      imageHeight: detected.imageHeight,
    });
    return box ? [{ box, embedding: parseEmbedding(face.embedding) }] : [];
  });
  if (reference) {
    let best: { box: [number, number, number, number]; similarity: number } | null = null;
    for (const candidate of candidates) {
      const similarity = candidate.embedding ? cosine(reference, candidate.embedding) : 0;
      if (similarity >= CUTOUT_FACE_MATCH && (!best || similarity > best.similarity)) {
        best = { box: candidate.box, similarity };
      }
    }
    return best?.box ?? null;
  }
  const centre = (box: number[]) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const [x, y] = centre(libraryBox);
  const distance = (box: number[]) => Math.hypot(centre(box)[0] - x, centre(box)[1] - y);
  return candidates.toSorted((a, b) => distance(a.box) - distance(b.box))[0]?.box ?? null;
};
