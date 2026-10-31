import { Page, TestInfo } from '@playwright/test';

const titles = new Set([
  'Go to a date - G',
  'The All header selects everything, months not yet loaded included',
  'Deep link to last photo, scroll up',
  'Deep link to first bucket, scroll down',
]);

// Diagnostic retries are not a performance baseline: sampling and the existing trace add overhead.
const installObserver = () => {
  const entries: { startTime: number; duration: number }[] = [];
  let dropped = 0;
  const record = (records: PerformanceEntry[]) => {
    for (const entry of records) {
      if (entries.length < 1000) {
        entries.push({ startTime: entry.startTime, duration: entry.duration });
      } else {
        dropped++;
      }
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ type: 'longtask', buffered: true });
  const timer = setTimeout(() => observer.disconnect(), 30_000);
  Object.assign(globalThis, {
    __frameleafTimelineProfile: () => {
      clearTimeout(timer);
      record(observer.takeRecords());
      observer.disconnect();
      return { entries, dropped };
    },
  });
};

export const startTimelineProfile = async (page: Page, info: TestInfo, browserName: string) => {
  if (info.retry !== 1 || browserName !== 'chromium' || !titles.has(info.title)) {
    return async () => {};
  }
  const errors: string[] = [];
  const bounded = async <T>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Diagnostic deadline')), 1000);
        }),
      ]);
    } catch {
      errors.push(`UNKNOWN: ${label} unavailable or timed out`);
    } finally {
      clearTimeout(timer);
    }
  };
  const pending = page.context().newCDPSession(page);
  const session = await bounded('CDP session creation', () => pending);
  const script = session
    ? await bounded('observer installation', () =>
        session.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installObserver.toString()})()` }),
      )
    : undefined;
  const scriptId = script?.identifier;
  const capture: { timer?: ReturnType<typeof setTimeout> } = {};
  let collection: Promise<{ profile?: unknown; longTasks?: unknown; metrics?: unknown }> | undefined;
  const collect = () => {
    collection ??= (async () => {
      clearTimeout(capture.timer);
      if (!session) {
        return {};
      }
      const cdp = session;
      try {
        const [cpu, tasks, metrics] = await Promise.all([
          bounded('Profiler.stop', () => cdp.send('Profiler.stop')),
          bounded('long-task observer cleanup', () =>
            cdp.send('Runtime.evaluate', {
              expression: 'globalThis.__frameleafTimelineProfile?.()',
              returnByValue: true,
            }),
          ),
          bounded('Performance.getMetrics', () => cdp.send('Performance.getMetrics')),
        ]);
        if (!cpu?.profile) {
          errors.push('UNKNOWN: CPU profile data unavailable');
        }
        if (!tasks?.result.value || tasks.exceptionDetails) {
          errors.push('UNKNOWN: long-task observer data unavailable');
        }
        return { profile: cpu?.profile, longTasks: tasks?.result.value, metrics: metrics?.metrics };
      } finally {
        await bounded('Profiler.disable', () => cdp.send('Profiler.disable'));
        if (scriptId) {
          await bounded('observer script removal', () =>
            cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }),
          );
        }
        await bounded('CDP detach', () => cdp.detach());
      }
    })();
    return collection;
  };
  let attached = false;
  const finish = async () => {
    if (attached) {
      return;
    }
    attached = true;
    const { profile, ...diagnostics } = await collect();
    let cpuAttached = false;
    if (profile && info.status !== info.expectedStatus) {
      const body = Buffer.from(JSON.stringify(profile));
      if (body.length <= 8 * 1024 * 1024) {
        cpuAttached = !!(await bounded('CPU profile attachment', async () => {
          await info.attach('timeline-cpu.cpuprofile', { body, contentType: 'application/json' });
          return true;
        }));
      } else {
        errors.push('UNKNOWN: CPU profile exceeds 8MiB attachment limit');
      }
    }
    await bounded('diagnostic attachment', () =>
      info.attach('timeline-profile.json', {
        contentType: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            title: info.title,
            retry: info.retry,
            status: info.status,
            baselineAcceptance: false,
            samplingIntervalUs: 2000,
            captureLimitMs: 30_000,
            cpuAttached,
            ...diagnostics,
            errors,
          }),
        ),
      }),
    );
  };

  if (!session) {
    // A session arriving after our deadline must not leak into the next test.
    void pending.then((late) => bounded('late CDP detach', () => late.detach())).catch(() => {});
    return finish;
  }
  const cdp = session;
  if (
    !scriptId ||
    !(await bounded('Profiler.enable', () => cdp.send('Profiler.enable'))) ||
    !(await bounded('Profiler.setSamplingInterval', () =>
      cdp.send('Profiler.setSamplingInterval', { interval: 2000 }),
    )) ||
    !(await bounded('Performance.enable', () => cdp.send('Performance.enable'))) ||
    !(await bounded('Profiler.start', () => cdp.send('Profiler.start')))
  ) {
    await collect();
    return finish;
  }
  capture.timer = setTimeout(() => void collect(), 30_000);
  return finish;
};
