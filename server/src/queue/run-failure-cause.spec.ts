import { JobName } from 'src/enum.js';
import {
  FAILURE_PATTERNS,
  NIGHTLY_RUN_KINDS,
  RUN_FAILURE_CAUSES,
  runFailureCause,
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
