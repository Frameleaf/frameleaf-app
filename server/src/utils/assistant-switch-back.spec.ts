import { Registry } from 'prom-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantSwitchBack, SWITCH_BACK_LIMIT, SWITCH_BACK_WINDOW_MS } from 'src/utils/assistant-switch-back.js';

let metric: AssistantSwitchBack;
let registry: Registry;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  metric = new AssistantSwitchBack();
  registry = new Registry();
  metric.register(registry);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('counts signed-in answers and only one switch from the answering session', async () => {
  expect(metric.answer(undefined)).toBeUndefined();
  const token = metric.answer('private-session')!;
  const another = metric.answer('private-session')!;
  expect(token).not.toBe(another);
  metric.switchBack(undefined, token);
  metric.switchBack('other-session', token);
  metric.switchBack('private-session', token);
  metric.switchBack('private-session', token);
  const body = await registry.metrics();
  expect(body).toContain('frameleaf_assistant_searches_total 2');
  expect(body).toContain('frameleaf_assistant_switch_backs_total 1');
  for (const value of [token, another, 'private-session', 'other-session']) {
    expect(body).not.toContain(value);
  }
});

it('expires a token after thirty seconds', async () => {
  const valid = metric.answer('session')!;
  const expired = metric.answer('session')!;
  vi.advanceTimersByTime(SWITCH_BACK_WINDOW_MS - 1);
  metric.switchBack('session', valid);
  vi.advanceTimersByTime(1);
  metric.switchBack('session', expired);
  expect(await registry.metrics()).toContain('frameleaf_assistant_switch_backs_total 1');
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds pending tokens and retains recent answers', async () => {
  const evicted = metric.answer('session')!;
  let latest = evicted;
  for (let i = 0; i < SWITCH_BACK_LIMIT; i++) {
    latest = metric.answer('session')!;
  }
  expect(vi.getTimerCount()).toBe(SWITCH_BACK_LIMIT);
  metric.switchBack('session', evicted);
  metric.switchBack('session', latest);
  expect(await registry.metrics()).toContain('frameleaf_assistant_switch_backs_total 1');
});
