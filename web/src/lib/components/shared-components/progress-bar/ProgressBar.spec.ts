import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import ProgressBarFixture from '@test-data/components/ProgressBarFixture.svelte';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
});

afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
});

const mountBar = (autoplay = false) => {
  const onDone = vi.fn();
  const onPlaying = vi.fn();
  const onPaused = vi.fn();
  const result = render(ProgressBarFixture, { duration: 1, autoplay, onDone, onPlaying, onPaused });
  flushSync();
  const width = () => Number(result.container.querySelector('span')!.style.width.slice(0, -1));
  const advance = async (milliseconds: number) => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    flushSync();
  };
  return { ...result, component: result.component.getBar(), width, advance, onDone, onPlaying, onPaused };
};

it('starts paused without announcing playback', async () => {
  const bar = mountBar();
  await bar.advance(1200);
  expect(bar.width()).toBe(0);
  expect(bar.onPlaying).not.toHaveBeenCalled();
  expect(bar.onDone).not.toHaveBeenCalled();
});

it('autoplays once and completes once', async () => {
  const bar = mountBar(true);
  await bar.advance(500);
  expect(bar.width()).toBeGreaterThan(40);
  expect(bar.width()).toBeLessThan(60);
  await bar.advance(700);
  expect(bar.width()).toBe(100);
  expect(bar.onPlaying).toHaveBeenCalledTimes(1);
  expect(bar.onDone).toHaveBeenCalledTimes(1);
});

it('holds the current position immediately on pause and resumes the remaining duration', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  await bar.component.pause();
  flushSync();
  const paused = bar.width();
  await bar.advance(1200);
  expect(bar.width()).toBe(paused);
  expect(bar.onPaused).toHaveBeenCalledTimes(1);
  expect(bar.onDone).not.toHaveBeenCalled();
  const playing = bar.component.play();
  await bar.advance(700);
  await playing;
  expect(bar.onDone).toHaveBeenCalledTimes(1);
});

it('resets a changed duration while preserving pause', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  await bar.component.pause();
  await bar.rerender({ duration: 2 });
  await bar.advance(2500);
  expect(bar.width()).toBe(0);
  expect(bar.onPlaying).toHaveBeenCalledTimes(1);
  expect(bar.onDone).not.toHaveBeenCalled();
  void bar.component.play();
  await bar.advance(1000);
  expect(bar.width()).toBeGreaterThan(40);
  expect(bar.width()).toBeLessThan(60);
});

it('restarts the full changed duration while playing', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  await bar.rerender({ duration: 2 });
  await bar.advance(1000);
  expect(bar.width()).toBeGreaterThan(40);
  expect(bar.width()).toBeLessThan(60);
  expect(bar.onDone).not.toHaveBeenCalled();
  await bar.advance(1200);
  expect(bar.onDone).toHaveBeenCalledTimes(1);
});

it('restarts from zero while preserving pause', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  await bar.component.pause();
  await bar.component.restart();
  await bar.advance(1200);
  expect(bar.width()).toBe(0);
  expect(bar.onDone).not.toHaveBeenCalled();
});

it('resets immediately so a completion handler can advance the slide', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  await bar.component.resetProgress();
  flushSync();
  expect(bar.width()).toBe(0);
  await bar.advance(1200);
  expect(bar.onDone).not.toHaveBeenCalled();
});

it('keeps timing while the visual bar is hidden', async () => {
  const bar = mountBar(true);
  await bar.rerender({ hidden: true });
  expect(bar.container.querySelector('span')).toBeNull();
  await bar.advance(1200);
  expect(bar.onDone).toHaveBeenCalledTimes(1);
});

it('cannot restart playback through a retained instance after unmount', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  bar.unmount();
  await bar.component.restart();
  void bar.component.play();
  await bar.advance(1200);
  expect(bar.onPlaying).toHaveBeenCalledTimes(1);
  expect(bar.onDone).not.toHaveBeenCalled();
});

it('does not repeat completion when its callback changes', async () => {
  const bar = mountBar(true);
  await bar.advance(1200);
  const replacement = vi.fn();
  await bar.rerender({ onDone: replacement });
  expect(bar.onDone).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

it('does not resume a restart suspended across unmount', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  const restarting = bar.component.restart();
  bar.unmount();
  await restarting;
  await bar.advance(1200);
  expect(bar.onPlaying).toHaveBeenCalledTimes(1);
  expect(bar.onDone).not.toHaveBeenCalled();
});

it('honors a pause requested by the playback callback', async () => {
  const bar = mountBar();
  await bar.rerender({ onPlaying: () => void bar.component.pause() });
  await bar.component.play();
  await bar.advance(1200);
  expect(bar.width()).toBe(0);
  expect(bar.onDone).not.toHaveBeenCalled();
});

it('honors playback requested by the pause callback', async () => {
  const bar = mountBar(true);
  await bar.advance(400);
  await bar.rerender({ onPaused: () => void bar.component.play() });
  await bar.component.pause();
  await bar.advance(700);
  expect(bar.onDone).toHaveBeenCalledTimes(1);
});

it('does not start an animation after its playback callback unmounts the component', async () => {
  const bar = mountBar();
  await bar.rerender({ onPlaying: () => bar.unmount() });
  await bar.component.play();
  await bar.advance(1200);
  expect(bar.onDone).not.toHaveBeenCalled();
});
