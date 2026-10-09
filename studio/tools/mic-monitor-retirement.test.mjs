import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const directory = new URL('../engine/src/', import.meta.url);
const read = (path) => readFile(new URL(path, directory), 'utf8');
const url = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const meter = url(await read('infrastructure/audio/mic-recorder/meter.ts'));
const recorder = url((await read('infrastructure/audio/mic-recorder/mic-recorder.ts')).replace("'./meter'", JSON.stringify(meter)));
const monitorModule = url((await read('infrastructure/audio/mic-recorder/monitor.ts')).replace("'./meter'", JSON.stringify(meter)).replace("'./mic-recorder'", JSON.stringify(recorder)));
const { startMicLevelMonitor } = await import(monitorModule);
const devices = await import(url(await read('infrastructure/audio/mic-recorder/devices.ts')));
const controller = await read('features/timeline/services/mic-recording-controller.ts');
const monitorSource = controller.slice(controller.indexOf('export async function startMicMonitor'), controller.indexOf('function startElapsedTimer'));
const refreshSource = `${controller.match(/^let deviceRefreshGeneration.*$/m)?.[0] ?? ''}\n${controller.slice(controller.indexOf('export async function refreshMicDevices'), controller.indexOf('export async function startMicRecording'))}`;
const component = await read('features/timeline/components/mic-record-control.tsx');
const effectStart = component.indexOf('useEffect(() => {');
const effect = component.slice(effectStart + 'useEffect(() => {'.length, component.indexOf('}, [])', effectStart));
let generation = 0;

async function setup(t) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const requests = [];
  const events = new EventTarget();
  let available = [{ kind: 'audioinput', deviceId: 'A', label: 'Mic A' }];
  events.getUserMedia = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  events.enumerateDevices = async () => available;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: events });
  const store = { status: 'idle', selectedDeviceId: 'A', level: 0, devices: [],
    setLevel(value) { this.level = value }, setSelectedDeviceId(value) { this.selectedDeviceId = value },
    setDevices(value) { this.devices = value } };
  let meters = 0, closes = 0;
  const queuedLevels = [];
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const originals = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  globalThis.window = { AudioContext: class {
    constructor() { meters++ }
    createMediaStreamSource() { return { connect() {} } }
    createAnalyser() { return { fftSize: 1024, getByteTimeDomainData(data) { data.fill(255) } } }
    async close() { closes++ }
  } };
  globalThis.requestAnimationFrame = (callback) => { queuedLevels.push(callback); return 1 };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.__micMonitorTest = { startMicLevelMonitor, store, ...devices };
  const api = await import(url(`const {startMicLevelMonitor,store,enumerateAudioInputs,onAudioInputDevicesChanged}=globalThis.__micMonitorTest;
    const useMicRecordingStore={getState:()=>store};const isMicRecordingActive=(status)=>status==='recording'||status==='paused';
    const logger={warn(){}};let monitor=null,monitorToken=0,lastLevelAt=0;const LEVEL_THROTTLE_MS=40;
    ${refreshSource}${monitorSource}
    const cancelMicRecording=()=>{},cancelPendingMicRecording=()=>{};
    export function mount(){${effect}}
    // Separate controller singleton per test, as in separate editor lifetimes.
    const generation=${generation++};`));
  t.after(() => {
    api.stopMicMonitor();
    Object.assign(globalThis, originals);
    delete globalThis.__micMonitorTest;
    if (previous) Object.defineProperty(navigator, 'mediaDevices', previous);
    else delete navigator.mediaDevices;
  });
  const stream = () => { const stop = t.mock.fn(); return { getTracks: () => [{ stop }], stop } };
  return { api, store, requests, stream, events, replace: (value) => { available = value }, meters: () => meters, closes: () => closes, queuedLevels, at: (value) => { now = value } };
}

test('permission grant after picker close releases stream before any meter or level publication', async (t) => {
  const s = await setup(t); const pending = s.api.startMicMonitor(); s.api.stopMicMonitor();
  const stream = s.stream(); s.requests[0].resolve(stream); await pending;
  assert.equal(s.meters(), 0); assert.equal(s.store.level, 0); assert.equal(stream.stop.mock.callCount(), 1);
});

test('replacement retires older permission request while current monitor meters and cleans up', async (t) => {
  const s = await setup(t); const old = s.api.startMicMonitor(); s.api.stopMicMonitor();
  s.store.selectedDeviceId = 'B'; const current = s.api.startMicMonitor();
  const oldStream = s.stream(); s.requests[0].resolve(oldStream); await old;
  assert.equal(s.meters(), 0); assert.equal(s.store.level, 0); assert.equal(oldStream.stop.mock.callCount(), 1);
  const currentStream = s.stream(); s.requests[1].resolve(currentStream); await current;
  assert.equal(s.meters(), 1); assert.equal(s.store.level, 0.9921875);
  s.api.stopMicMonitor(); s.api.stopMicMonitor();
  assert.equal(currentStream.stop.mock.callCount(), 1); assert.equal(s.closes(), 1); assert.equal(s.store.level, 0);
});

test('permission refusal stays idle without metering', async (t) => {
  const s = await setup(t); const pending = s.api.startMicMonitor();
  s.requests[0].reject(new DOMException('Denied', 'NotAllowedError')); await pending;
  assert.equal(s.meters(), 0); assert.equal(s.store.level, 0); assert.equal(s.store.status, 'idle');
});

test('toolbar devicechange retires a removed pending selection and unsubscribes on teardown', async (t) => {
  const s = await setup(t); const unmount = s.api.mount(); await Promise.resolve(); await Promise.resolve();
  const pending = s.api.startMicMonitor();
  s.replace([{ kind: 'audioinput', deviceId: 'B', label: 'Mic B' }]); s.events.dispatchEvent(new Event('devicechange'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(s.store.selectedDeviceId, null); assert.equal(s.store.devices[0].deviceId, 'B');
  const stream = s.stream(); s.requests[0].resolve(stream); await pending;
  assert.equal(s.meters(), 0); assert.equal(stream.stop.mock.callCount(), 1);
  unmount(); s.replace([]); s.events.dispatchEvent(new Event('devicechange')); await Promise.resolve();
  assert.equal(s.store.devices[0].deviceId, 'B');
});

test('device removal during recording refreshes selection without changing recording level or status', async (t) => {
  const s = await setup(t); const unmount = s.api.mount(); await Promise.resolve(); await Promise.resolve();
  s.store.status = 'recording'; s.store.level = 0.25;
  s.replace([]); s.events.dispatchEvent(new Event('devicechange')); await Promise.resolve(); await Promise.resolve();
  assert.equal(s.store.selectedDeviceId, null); assert.equal(s.store.level, 0.25); assert.equal(s.store.status, 'recording');
  unmount();
});

test('queued meter delivery cannot overwrite a replacement recording level', async (t) => {
  const s = await setup(t); const pending = s.api.startMicMonitor();
  s.requests[0].resolve(s.stream()); await pending;
  s.api.stopMicMonitor(); s.store.status = 'recording'; s.store.level = 0.25;
  s.at(2000); s.queuedLevels[0]();
  assert.equal(s.store.level, 0.25); assert.equal(s.store.status, 'recording');
});

test('device enumeration completed after toolbar teardown cannot publish replacement devices', async (t) => {
  const s = await setup(t); const unmount = s.api.mount(); await Promise.resolve(); await Promise.resolve();
  let release; s.events.enumerateDevices = () => new Promise((resolve) => { release = resolve });
  s.events.dispatchEvent(new Event('devicechange')); unmount();
  release([{ kind: 'audioinput', deviceId: 'B', label: 'Mic B' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(s.store.devices[0].deviceId, 'A'); assert.equal(s.store.selectedDeviceId, 'A');
});

for (const caller of ['direct', 'toolbar']) {
  test(`${caller} reverse-order enumerations preserve replacement selection and live monitor`, async (t) => {
    const s = await setup(t);
    const enumerations = [];
    s.events.enumerateDevices = () => new Promise((resolve) => { enumerations.push(resolve) });
    let older, newer, unmount;
    if (caller === 'toolbar') {
      unmount = s.api.mount();
      s.events.dispatchEvent(new Event('devicechange'));
    } else {
      older = s.api.refreshMicDevices(); newer = s.api.refreshMicDevices();
    }
    assert.equal(enumerations.length, 2);
    enumerations[1]([{ kind: 'audioinput', deviceId: 'B', label: 'Mic B' }]);
    await newer; await Promise.resolve(); await Promise.resolve();
    s.store.selectedDeviceId = 'B';
    const opening = s.api.startMicMonitor(); const stream = s.stream();
    s.requests[0].resolve(stream); await opening;
    enumerations[0]([{ kind: 'audioinput', deviceId: 'A', label: 'Mic A' }]);
    await older; await Promise.resolve(); await Promise.resolve();
    assert.equal(s.store.devices[0].deviceId, 'B');
    assert.equal(s.store.selectedDeviceId, 'B'); assert.equal(stream.stop.mock.callCount(), 0);
    assert.equal(s.store.level, 0.9921875); assert.equal(s.meters(), 1);
    if (unmount) unmount(); else s.api.stopMicMonitor();
    assert.equal(stream.stop.mock.callCount(), 1);
  });
}
