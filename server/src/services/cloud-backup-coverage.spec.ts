import type { CloudBackupCoverageReport } from 'src/repositories/cloud-backup-selection.repository.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import { CloudBackupCoverage } from 'src/services/cloud-backup-coverage.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

const RUN = '01900000-0000-7000-8000-0000000000aa';
const INSTANCE = '01900000-0000-7000-8000-000000000001';
const fp = (n: number) => n.toString(16).padStart(64, '0');
const refusal = (status: number | null, code?: string) =>
  new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, status, 'refused', code ? ({ code } as never) : null);

/** An in-memory stand-in for the selection repository's inventory and report rows. */
const fakeSelection = (accounts: number) => {
  const reports = new Map<string, CloudBackupCoverageReport>();
  const repository = {
    getCoverageReport: vi.fn((runId: string) => Promise.resolve(reports.get(runId))),
    getDecisionRun: vi.fn(() =>
      Promise.resolve({
        runId: RUN,
        manifestKey: 'm/20261016T120000Z.json.gz',
        inventoryAt: new Date('2026-10-16T12:00:00.000Z'),
        licenceScope: 'all',
      }),
    ),
    getDecisionAccounts: vi.fn(() =>
      Promise.resolve(
        Array.from({ length: accounts }, (_, index) => ({
          userId: `user-${index}`,
          userFingerprint: fp(accounts - index),
          selectionHash: null,
          totalOriginals: 10,
          selectedOriginals: 4,
          licenceEligible: index !== 0,
          includedOriginals: index === 0 ? 0 : 3,
        })),
      ),
    ),
    createCoverageReport: vi.fn((report: Record<string, unknown>) => {
      if (!reports.has(report.runId as string)) {
        reports.set(
          report.runId as string,
          {
            attempts: 0,
            nextAttemptAt: null,
            lastError: null,
            createdAt: new Date(),
            publishedAt: null,
            revisionAccepted: false,
            ...report,
          } as unknown as CloudBackupCoverageReport,
        );
      }
      return Promise.resolve(reports.get(report.runId as string)!);
    }),
    updateCoverageReport: vi.fn((runId: string, patch: Partial<CloudBackupCoverageReport>) => {
      reports.set(runId, { ...reports.get(runId)!, ...patch });
      return Promise.resolve();
    }),
    listDueCoverageReports: vi.fn(() => Promise.resolve(reports.values().toArray().filter((r) => r.status === 'pending'))),
    getLatestCoverageReport: vi.fn(() => Promise.resolve(reports.values().toArray().at(-1))),
  };
  return { repository, reports };
};

const fakeCloud = () => {
  const sent: Array<{ route: string; body?: unknown }> = [];
  const cloud = {
    reportRun: vi.fn((_target: unknown, body: unknown) => {
      sent.push({ route: 'run', body });
      return Promise.resolve();
    }),
    beginCoverage: vi.fn((_target: unknown, _run: string, header: unknown) => {
      sent.push({ route: 'begin', body: header });
      return Promise.resolve({});
    }),
    putCoveragePage: vi.fn((_target: unknown, _run: string, revisionId: string, index: number, body: string) => {
      sent.push({ route: `page ${revisionId} ${index}`, body });
      return Promise.resolve({ revisionId, pageIndex: index });
    }),
    finalizeCoverage: vi.fn((_target: unknown, _run: string, revisionId: string) => {
      sent.push({ route: `finalize ${revisionId}` });
      return Promise.resolve({});
    }),
    getCoverageState: vi.fn(() => Promise.resolve({ published: null, pending: null })),
  };
  return { cloud, sent };
};

describe(CloudBackupCoverage.name, () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const target = { api: 'https://api.frameleaf.test', token: {} };
  let linked: string | null;

  const build = (accounts = 33) => {
    const selection = fakeSelection(accounts);
    const { cloud, sent } = fakeCloud();
    const sut = new CloudBackupCoverage(
      selection.repository as never,
      cloud as never,
      logger as never,
      () => Promise.resolve(target as never),
      () => Promise.resolve(linked),
    );
    return { sut, cloud, sent, reports: selection.reports, repository: selection.repository };
  };
  const legacy = { kind: 'legacy' as const, manifestKey: 'm/20261016T120000Z.json.gz' };
  const runReport = {
    runId: RUN,
    status: 'succeeded' as const,
    startedAt: '2026-10-16T11:59:00.000Z',
    finishedAt: '2026-10-16T12:10:00.000Z',
    bytesUploaded: 0,
    objectsUploaded: 0,
    objectsSkipped: 0,
    manifestKey: 'm/20261016T120000Z.json.gz',
    errorCode: null,
  };
  const now = new Date('2026-10-16T12:20:00.000Z');

  beforeEach(() => {
    linked = INSTANCE;
  });

  it('publishes every account in pages of 32, with only numbers and opaque references', async () => {
    const { sut, sent, reports } = build(33);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    await sut.publish(RUN, now);

    expect(sent.map(({ route }) => route.split(' ', 1)[0])).toEqual(['begin', 'page', 'page', 'finalize']);
    const [first, second] = sent
      .filter(({ route }) => route.startsWith('page'))
      .map(({ body }) => JSON.parse(body as string));
    expect(first.rows).toHaveLength(32);
    expect(second.rows).toHaveLength(1);
    const fingerprints = [...first.rows, ...second.rows].map((row: { userFingerprint: string }) => row.userFingerprint);
    expect(fingerprints).toEqual(fingerprints.toSorted());
    expect(Object.keys(first.rows[0]).toSorted()).toEqual(
      ['includedOriginals', 'licenceEligible', 'selectedOriginals', 'totalOriginals', 'userFingerprint'].toSorted(),
    );
    const ineligible = [...first.rows, ...second.rows].find(
      (row: { licenceEligible: boolean }) => !row.licenceEligible,
    );
    expect(ineligible.includedOriginals).toBe(0);
    expect(reports.get(RUN)).toMatchObject({ status: 'published', revisionAccepted: true });
  });

  it('recovers a lost finalize answer from the published state and resends nothing', async () => {
    const { sut, cloud, sent, reports } = build(2);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    cloud.finalizeCoverage.mockRejectedValueOnce(refusal(null));
    await sut.publish(RUN, now);
    expect(reports.get(RUN)).toMatchObject({ status: 'pending', attempts: 1, revisionAccepted: true });

    const revisionId = reports.get(RUN)!.revisionId;
    cloud.getCoverageState.mockResolvedValueOnce({ published: { revisionId } as never, pending: null });
    const before = sent.length;
    await sut.publish(RUN, new Date(now.getTime() + 600_000));
    expect(sent.length).toBe(before);
    expect(reports.get(RUN)).toMatchObject({ status: 'published', revisionId });
  });

  it('replays exactly the same bytes after an interrupted attempt', async () => {
    const { sut, cloud, sent, reports } = build(40);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    cloud.putCoveragePage.mockRejectedValueOnce(refusal(503));
    await sut.publish(RUN, now);
    const firstHeader = sent.find(({ route }) => route === 'begin')!.body;
    sent.length = 0;
    await sut.publish(RUN, new Date(now.getTime() + 3_600_000));
    expect(sent.find(({ route }) => route === 'begin')!.body).toEqual(firstHeader);
    expect(sent.filter(({ route }) => route.startsWith('page')).map(({ body }) => body)).toEqual(
      reports.get(RUN)!.pages,
    );
    expect(sent.at(-1)!.route).toMatch(/^finalize/);
  });

  it('starts a later revision with the same pages when the unpublished one expired', async () => {
    const { sut, cloud, sent, reports } = build(3);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    const firstRevision = reports.get(RUN)!.revisionId;
    cloud.putCoveragePage.mockRejectedValueOnce(refusal(404, 'not-found'));
    await sut.publish(RUN, now);

    const report = reports.get(RUN)!;
    expect(report).toMatchObject({ status: 'published', sequence: 2 });
    expect(report.revisionId).not.toBe(firstRevision);
    const pages = sent.filter(({ route }) => route.startsWith('page')).map(({ body }) => body);
    expect(pages[0]).toBe(pages.at(-1));
  });

  it('never publishes over a conflicting revision', async () => {
    const { sut, cloud, reports } = build(2);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    cloud.beginCoverage.mockRejectedValueOnce(refusal(409, 'idempotency-conflict'));
    await sut.publish(RUN, now);
    expect(reports.get(RUN)).toMatchObject({ status: 'rejected' });
    expect(cloud.finalizeCoverage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('publishes a failed run without a committed snapshot with unknown inclusion', async () => {
    const { sut, sent } = build(2);
    await sut.write({
      runId: RUN,
      managed: true,
      instanceId: INSTANCE,
      snapshot: null,
      runReport: { ...runReport, status: 'failed' },
    });
    await sut.publish(RUN, now);
    expect((sent[0].body as { snapshot: unknown }).snapshot).toBeNull();
    const rows = JSON.parse(sent[1].body as string).rows as Array<{ includedOriginals: number | null }>;
    expect(rows.every(({ includedOriginals }) => includedOriginals === null)).toBe(true);
  });

  it('reports the run again when Frameleaf Cloud does not know it, and waits when the route is missing', async () => {
    const { sut, cloud, reports } = build(2);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    cloud.beginCoverage.mockRejectedValue(refusal(404));
    await sut.publish(RUN, now);
    expect(cloud.reportRun).toHaveBeenCalledWith(target, runReport);
    expect(reports.get(RUN)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(reports.get(RUN)!.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('drops the legacy reference when an older Frameleaf Cloud refuses the manifest key', async () => {
    const { sut, cloud, reports } = build(2);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    cloud.beginCoverage.mockRejectedValueOnce(refusal(404));
    cloud.reportRun.mockRejectedValueOnce(refusal(400, 'request-invalid'));
    await sut.publish(RUN, now);
    expect(cloud.reportRun).toHaveBeenLastCalledWith(target, { ...runReport, manifestKey: null });
    expect(reports.get(RUN)).toMatchObject({ status: 'pending', snapshot: null, revisionAccepted: false });
    const rows = JSON.parse(reports.get(RUN)!.pages[0]).rows as Array<{ includedOriginals: number | null }>;
    expect(rows.every(({ includedOriginals }) => includedOriginals === null)).toBe(true);

    await sut.publish(RUN, now);
    expect(reports.get(RUN)).toMatchObject({ status: 'published' });
  });

  it('never sends a report written by another instance, or one past the run window', async () => {
    const { sut, cloud, reports } = build(2);
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: legacy, runReport });
    linked = '01900000-0000-7000-8000-0000000000ff';
    await sut.publish(RUN, now);
    expect(reports.get(RUN)).toMatchObject({ status: 'expired' });
    expect(cloud.beginCoverage).not.toHaveBeenCalled();
  });

  it('binds a report written while unlinked to the instance it is first sent as', async () => {
    const { sut, reports } = build(1);
    await sut.write({ runId: RUN, managed: true, instanceId: null, snapshot: legacy, runReport });
    expect(reports.get(RUN)).toMatchObject({ status: 'pending', instanceId: null });
    await sut.publish(RUN, now);
    expect(reports.get(RUN)).toMatchObject({ status: 'published', instanceId: INSTANCE });
  });

  it('keeps an own-bucket report local, and writes a report once', async () => {
    const { sut, cloud, reports, repository } = build(2);
    await sut.write({ runId: RUN, managed: false, instanceId: null, snapshot: legacy, runReport: null });
    await sut.write({ runId: RUN, managed: true, instanceId: INSTANCE, snapshot: null, runReport });
    expect(repository.createCoverageReport).toHaveBeenCalledTimes(1);
    await sut.publish(RUN, now);
    expect(cloud.beginCoverage).not.toHaveBeenCalled();
    await expect(sut.state()).resolves.toMatchObject({ state: 'local', runId: RUN });
    expect(reports.get(RUN)!.snapshot).toEqual(legacy);
  });
});
