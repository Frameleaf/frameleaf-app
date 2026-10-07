import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Exercise the prepared production module with browser capture events; no engine dependencies or mic permission.
const directory = new URL('../engine/src/infrastructure/audio/mic-recorder/', import.meta.url);
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const meter = moduleUrl(await readFile(new URL('meter.ts', directory), 'utf8'));
const source = await readFile(new URL('mic-recorder.ts', directory), 'utf8');
const { MicRecorder } = await import(moduleUrl(source.replace("'./meter'", JSON.stringify(meter))));

class Capture extends EventTarget {
  static isTypeSupported() { return true; }
  static latest;
  state = 'inactive';
  mimeType = 'audio/webm';
  stopCalls = 0;
  constructor() { super(); Capture.latest = this; }
  start() { this.state = 'recording'; queueMicrotask(() => this.dispatchEvent(new Event('start'))); }
  pause() {
    if (this.state === 'inactive') throw new DOMException('Capture ended', 'InvalidStateError');
    this.state = 'paused';
  }
  resume() {
    if (this.state === 'inactive') throw new DOMException('Capture ended', 'InvalidStateError');
    this.state = 'recording';
  }
  stop() {
    this.stopCalls++;
    if (this.state === 'inactive') throw new DOMException('Capture ended', 'InvalidStateError');
    this.end();
  }
  end(error) {
    this.state = 'inactive';
    queueMicrotask(() => {
      if (error) this.dispatchEvent(Object.assign(new Event('error'), { error }));
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['final audio']) }));
      this.dispatchEvent(new Event('stop'));
    });
  }
}

function setup(t) {
  let now = 1000;
  const originalRecorder = globalThis.MediaRecorder;
  const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const trackStop = t.mock.fn();
  globalThis.MediaRecorder = Capture;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: t.mock.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
  });
  t.mock.method(performance, 'now', () => now);
  t.after(() => {
    globalThis.MediaRecorder = originalRecorder;
    if (originalDevices) Object.defineProperty(navigator, 'mediaDevices', originalDevices);
    else delete navigator.mediaDevices;
  });
  return { recorder: new MicRecorder(), trackStop, at: (value) => { now = value; } };
}

test('normal stop retains final audio and excludes paused time', async (t) => {
  const { recorder, at, trackStop } = setup(t);
  await recorder.start();
  at(1500); recorder.pause();
  at(3000); recorder.resume();
  at(3200);
  const result = await recorder.stop();
  assert.equal(result.durationMs, 700);
  assert.equal(await result.blob.text(), 'final audio');
  assert.equal(recorder.getState(), 'idle');
  assert.equal(trackStop.mock.callCount(), 1);
});

test('browser-ended capture keeps its audio and freezes duration before user stop', async (t) => {
  const { recorder, at, trackStop } = setup(t);
  await recorder.start();
  at(1500); Capture.latest.end();
  await Promise.resolve();
  at(9000);
  assert.equal(recorder.elapsedMs(), 500);
  const result = await recorder.stop();
  assert.equal(result.durationMs, 500);
  assert.equal(await result.blob.text(), 'final audio');
  assert.equal(Capture.latest.stopCalls, 0);
  assert.equal(trackStop.mock.callCount(), 1);
});

test('inactive capture waits for the queued final data and stop events', async (t) => {
  const { recorder, at } = setup(t);
  await recorder.start();
  at(1500); Capture.latest.end();
  const result = await recorder.stop();
  assert.equal(await result.blob.text(), 'final audio');
  assert.equal(result.durationMs, 500);
  assert.equal(Capture.latest.stopCalls, 0);
});

test('browser-ended paused capture excludes time after the pause', async (t) => {
  const { recorder, at } = setup(t);
  await recorder.start();
  at(1500); recorder.pause();
  at(9000); Capture.latest.end();
  await Promise.resolve();
  const result = await recorder.stop();
  assert.equal(result.durationMs, 500);
  assert.equal(await result.blob.text(), 'final audio');
});

test('pause and resume tolerate capture ending before its stop event', async (t) => {
  const { recorder } = setup(t);
  await recorder.start();
  Capture.latest.end();
  assert.doesNotThrow(() => recorder.pause());
  assert.doesNotThrow(() => recorder.resume());
  await recorder.stop();
});

test('native errors before stop are reported and release the stream', async (t) => {
  const { recorder, trackStop } = setup(t);
  await recorder.start();
  const error = new DOMException('Input disconnected', 'NotReadableError');
  Capture.latest.end(error);
  await Promise.resolve();
  await assert.rejects(recorder.stop(), (actual) => actual === error);
  assert.equal(recorder.getState(), 'idle');
  assert.equal(trackStop.mock.callCount(), 1);
});

test('permission refusal leaves no active capture', async (t) => {
  const { recorder } = setup(t);
  const error = new DOMException('Permission denied', 'NotAllowedError');
  navigator.mediaDevices.getUserMedia = async () => { throw error; };
  await assert.rejects(recorder.start(), (actual) => actual === error);
  recorder.dispose();
  assert.equal(recorder.getState(), 'idle');
  await assert.rejects(recorder.stop(), /not active/);
});
