import { JobName } from 'src/enum.js';
import {
  FAILURE_PATTERNS,
  NIGHTLY_RUN_KINDS,
  QUEUE_PROBLEM_CAUSES,
  type QueueProblemInput,
  RUN_FAILURE_CAUSES,
  queueProblemCause,
  runFailureCause,
  singleMessage,
} from 'src/queue/run-failure-cause.js';

const upload = { asset: true, external: false, offline: false, finding: null };
const external = { asset: true, external: true, offline: false, finding: null };

describe('runFailureCause', () => {
  it('maps FL-1337 decoder words', () => {
    expect(runFailureCause({ ...upload, error: 'VipsJpeg: premature end of JPEG image' })).toBe('damaged');
    expect(runFailureCause({ ...upload, error: 'Input buffer contains unsupported image format' })).toBe('unsupported');
    expect(runFailureCause({ ...upload, error: 'Sharp child closed (code 1, signal null)' })).toBe('other');
    expect(runFailureCause({ ...upload, error: 'VipsJpeg: Invalid SOI parameters' })).toBe('damaged');
    expect(runFailureCause({ ...upload, error: 'APP1 segment too short' })).toBe('damaged');
    expect(runFailureCause({ ...upload, error: 'Timed out after 120 s' })).toBe('other');
    expect(runFailureCause({ ...upload, error: null })).toBe('other');
  });

  it('an offline external photo is a drive problem whatever the message', () => {
    for (const error of ['VipsJpeg: premature end of JPEG image', 'unsupported image format', null]) {
      expect(runFailureCause({ ...external, offline: true, error })).toBe('drive');
    }
    expect(runFailureCause({ ...upload, offline: true, error: null, finding: 'corrupt' })).toBe('drive');
  });

  it('ENOENT on an upload-library photo is missing; on an external one, drive', () => {
    const error = "ENOENT: no such file or directory, open '/photos/a.jpg'";
    expect(runFailureCause({ ...upload, error })).toBe('missing');
    expect(runFailureCause({ ...external, error })).toBe('drive');
    expect(runFailureCause({ ...external, error: 'EHOSTDOWN: host is down' })).toBe('drive');
    expect(runFailureCause({ ...upload, error: 'Original file not found' })).toBe('missing');
  });

  it("exiftool's damaged-file wordings, also doubled, are damaged (FL-1430)", () => {
    for (const error of [
      'File format error',
      'File format error; File format error',
      'Entire file is binary zeros',
      'Entire file is binary zeros; Entire file is binary zeros',
    ]) {
      expect(runFailureCause({ ...upload, error })).toBe('damaged');
      expect(runFailureCause({ ...external, error })).toBe('damaged');
    }
    // a network or model error that merely says "format" or "zeros" stays other
    expect(runFailureCause({ ...upload, error: 'Response format error from the model server' })).toBe('other');
  });

  it('shows a message exiftool doubled once', () => {
    expect(singleMessage('File format error; File format error')).toBe('File format error');
    expect(singleMessage('Entire file is binary zeros; Entire file is binary zeros')).toBe(
      'Entire file is binary zeros',
    );
    expect(singleMessage('Bad IFD; Truncated')).toBe('Bad IFD; Truncated');
    expect(singleMessage('Timed out')).toBe('Timed out');
    expect(singleMessage(null)).toBeNull();
  });

  it("machine learning's not found is not a missing file", () => {
    expect(runFailureCause({ ...upload, error: 'Request failed: 404 Not Found' })).toBe('other');
    expect(runFailureCause({ ...upload, error: 'model not found: buffalo_l' })).toBe('other');
  });

  it('a task with no photo is other, never missing', () => {
    for (const error of ['ENOENT: no such file or directory', 'premature end', null]) {
      expect(runFailureCause({ ...upload, asset: false, error })).toBe('other');
      expect(runFailureCause({ ...external, asset: false, offline: true, error, finding: 'missing' })).toBe('other');
    }
  });

  it('an open corrupt finding wins over an unknown message', () => {
    expect(runFailureCause({ ...upload, error: 'Something odd', finding: 'corrupt' })).toBe('damaged');
    expect(runFailureCause({ ...upload, error: 'unsupported image format', finding: 'corrupt' })).toBe('damaged');
    expect(runFailureCause({ ...upload, error: 'premature end', finding: 'missing' })).toBe('missing');
  });

  it('does not read SOI inside another word', () => {
    expect(runFailureCause({ ...upload, error: 'poisoned cache' })).toBe('other');
  });

  it(String.raw`patterns contain no \b`, () => {
    for (const pattern of Object.values(FAILURE_PATTERNS)) {
      expect(pattern).not.toContain(String.raw`\b`);
      expect(() => new RegExp(pattern, 'i')).not.toThrow();
    }
  });

  it('names five causes and the nightly kinds', () => {
    expect(RUN_FAILURE_CAUSES).toEqual(['drive', 'missing', 'damaged', 'unsupported', 'other']);
    expect(NIGHTLY_RUN_KINDS).toEqual([JobName.OvernightSequence]);
  });
});

describe('queueProblemCause (FL-1486)', () => {
  const of = (error: string | null, more: Partial<QueueProblemInput> = {}) =>
    queueProblemCause({ ...upload, error, deadline: false, ...more });

  it('tells a machine-learning helper that did not answer from one that refused', () => {
    expect(
      of('Machine learning request \'{"clip":{}}\' to http://ml:3003 failed with status 503: Service Unavailable'),
    ).toBe('mlUnavailable');
    expect(of("Machine learning request '{}' to http://ml:3003 failed: fetch failed")).toBe('mlUnavailable');
    expect(of('Machine learning worker is busy; try again shortly')).toBe('mlUnavailable');
    expect(of("Machine learning request '{}' to http://ml:3003 failed with status 404: Not Found")).toBe('other');
  });

  it('a job stopped at its deadline took too long', () => {
    expect(of('Job deadline or cancellation requested')).toBe('tooLong');
    expect(of(null, { deadline: true })).toBe('tooLong');
    expect(of('Timed out after 120 s')).toBe('other');
  });

  it('a refused write is a folder problem; a refused read is not', () => {
    expect(of("EACCES: permission denied, mkdir '/library/library/admin/2019'")).toBe('writeDenied');
    expect(of("EPERM: operation not permitted, rename '/a' -> '/b'")).toBe('writeDenied');
    expect(of("EROFS: read-only file system, open '/library/thumbs/a.webp'")).toBe('writeDenied');
    expect(of("EACCES: permission denied, open '/library/upload/a.jpg'")).toBe('other');
  });

  it('what is known about the file wins over what the task said', () => {
    const ml = "Machine learning request '{}' to http://ml:3003 failed: fetch failed";
    expect(of(ml, { finding: 'missing' })).toBe('missing');
    expect(of(ml, { offline: true })).toBe('drive');
    // a damaged file whose task failed for the helper's reason is the helper's problem this time
    expect(of(ml, { finding: 'corrupt' })).toBe('mlUnavailable');
    expect(of('VipsJpeg: premature end of JPEG image')).toBe('damaged');
    expect(of('Input file contains unsupported image format')).toBe('unsupported');
  });

  it('work that is no photo’s can still say what went wrong', () => {
    expect(of('Job deadline or cancellation requested', { asset: false })).toBe('tooLong');
    expect(of('duplicate key value violates unique constraint', { asset: false })).toBe('other');
  });

  it('keeps the run causes in their order, so a photo takes the most telling one', () => {
    expect(QUEUE_PROBLEM_CAUSES.filter((cause) => (RUN_FAILURE_CAUSES as readonly string[]).includes(cause))).toEqual([
      ...RUN_FAILURE_CAUSES,
    ]);
  });
});
