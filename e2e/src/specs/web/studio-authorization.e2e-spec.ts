import {
  AlbumKind,
  AlbumUserRole,
  LoginResponseDto,
  acceptSharedSpaceInvitation,
  createStudioProject,
  removeUserFromAlbum,
} from '@frameleaf/sdk';
import { Browser, Page, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import { test, withAssetReadySetup } from 'src/web-test.js';

/**
 * FL-112, the `authorizationFailure` conformance axis: owner, shared, viewer, sensitive and revoked,
 * driven through each Studio authorization gate from a signed-in browser. Every request is sent by the
 * page itself (`fetch` with the session cookie), so it carries exactly what the app would send.
 *
 * A refusal is evidence, not a skip: a member refused at export passes when the answer is the same as
 * for a project that does not exist and carries nothing of the project (name, graph, source ids, file
 * names). The results are written per gate and case for `scripts/frameleaf-studio-authz-report.mjs`,
 * which attributes them to the conformance rows.
 *
 * Gates (server, 2026-09-30):
 * - project: open, rename (studio-project.service findAccessible / requireOwner)
 * - source:  source admission, the resolved resources and each source's own media
 * - preview: POST /studio/previews (authorizeRevision, then refused sources)
 * - export:  GET /studio/projects/:id/exports (studio-export.service requireOwnedProject)
 * - import:  GET /studio/projects/:id/imports (studio-project-import.service requireOwnedProject)
 * - bundle:  POST /studio/projects/:id/bundle (studio-bundle.service, owner only)
 */
const GATES = ['project', 'source', 'preview', 'export', 'import', 'bundle'] as const;
const CASES = ['owner', 'shared', 'viewer', 'sensitive', 'revoked'] as const;
type Gate = (typeof GATES)[number];
type Case = (typeof CASES)[number];
type Outcome = { result: 'passed' | 'failed'; reason?: string };

const OUT = process.env.FRAMELEAF_STUDIO_AUTHZ_OUT ?? 'test-results/studio-authorization-gates.json';
const PROJECT_NAME = 'FL-112 access';
const SENSITIVE_NAME = 'FL-112 sensitive';
const GRAPH_MARKER = 'fl112-graph-marker';
const pinCode = '246810';

const results: Record<string, Record<string, Outcome>> = Object.fromEntries(
  GATES.map((gate) => [gate, {} as Record<string, Outcome>]),
);

/** A random UUIDv7, the id shape Studio projects use, for "a project that does not exist". */
const uuidv7 = () => {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let index = 0; index < 6; index++) {
    bytes[index] = Number((now >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type Answer = { status: number; text: string };

/** A request sent by the page, as the signed-in browser. */
const call = (page: Page, method: string, path: string, body?: unknown): Promise<Answer> =>
  page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, path, body },
  );

/** Runs one gate × case check and records it; an assertion that fails is recorded, not thrown. */
const record = async (gate: Gate, scenario: Case, check: () => Promise<void>) => {
  try {
    await check();
    results[gate][scenario] = { result: 'passed' };
  } catch (error) {
    results[gate][scenario] = { result: 'failed', reason: String(error).slice(0, 500) };
  }
};

const probe = async (page: Page, gate: Gate, id: string): Promise<Answer> => {
  switch (gate) {
    case 'project': {
      return call(page, 'GET', `/studio/projects/${id}`);
    }
    case 'preview': {
      return call(page, 'POST', '/studio/previews', {
        projectId: id,
        revision: 1,
        time: { numerator: '0', denominator: '1' },
        quality: 'standard',
        viewportWidth: 640,
        viewportHeight: 360,
      });
    }
    case 'export': {
      return call(page, 'GET', `/studio/projects/${id}/exports`);
    }
    case 'import': {
      return call(page, 'GET', `/studio/projects/${id}/imports`);
    }
    case 'bundle': {
      return call(page, 'POST', `/studio/projects/${id}/bundle`, {});
    }
    case 'source': {
      return call(page, 'GET', `/studio/projects/${id}`);
    }
  }
};

/** Preview admitted: a frame request, or refused only for timing, which is decided after access and sources. */
const expectPreviewAdmitted = (answer: Answer, label: string) => {
  const admitted =
    answer.status === 201 ||
    answer.status === 200 ||
    (answer.status === 409 && JSON.parse(answer.text).code === 'studio_preview_timing_unknown');
  expect(admitted, `${label}: ${answer.status} ${answer.text}`).toBe(true);
};

const clip = (assetId: string) => ({ assetId });
const envelope = (clips: { assetId: string }[]) => ({
  schemaVersion: 1,
  engine: 'freecut',
  engineRevision: 'fl-112',
  graph: { id: 'seq-main', marker: GRAPH_MARKER, tracks: [{ id: 't-video', kind: 'video', clips }] },
});

/** The refusal a project that does not exist gets, from the same session and gate. */
const missing = (page: Page, gate: Gate) => probe(page, gate, uuidv7());

const statusOf = async (page: Page, path: string) => {
  const { status } = await call(page, 'GET', path);
  return status;
};
const jsonOf = async (page: Page, path: string) => {
  const { text } = await call(page, 'GET', path);
  return JSON.parse(text);
};

test.describe('Studio authorization gates (FL-112)', () => {
  test.describe.configure({ mode: 'serial' });

  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let editor: LoginResponseDto;
  let viewer: LoginResponseDto;
  let revoked: LoginResponseDto;
  let plain: { id: string };
  let secret: { id: string };
  let spaceId: string;
  let projectId: string;
  let sensitiveId: string;
  let secretFileName: string;

  const openAs = async (browser: Browser, user: LoginResponseDto) => {
    const context = await browser.newContext();
    await utils.setAuthCookies(context, user.accessToken);
    const page = await context.newPage();
    await page.goto('/photos');
    return page;
  };

  /** Nothing of either project, its graph or its sources is in an answer. */
  const expectNoTrace = (answer: Answer, label: string) => {
    for (const trace of [PROJECT_NAME, SENSITIVE_NAME, GRAPH_MARKER, plain.id, secret.id, secretFileName]) {
      expect(answer.text.includes(trace), `${label} mentions ${trace}`).toBe(false);
    }
  };

  /** Refused exactly as a project that does not exist is, and with nothing of this one. */
  const expectRefusedLikeMissing = async (page: Page, gate: Gate, id: string, label: string) => {
    const answer = await probe(page, gate, id);
    const baseline = await missing(page, gate);
    expect(answer.status, `${label}: ${answer.text}`).toBeGreaterThanOrEqual(400);
    expect(answer.status, label).toBe(baseline.status);
    expect(JSON.parse(answer.text).message, label).toBe(JSON.parse(baseline.text).message);
    expectNoTrace(answer, label);
  };
  /**
   * A member, who can see the project, is refused an owner-only gate honestly with 403 (FL-112 ruling,
   * 2026-09-30); only someone who cannot see it gets the missing-project 404. Nothing leaks either way.
   */
  const expectOwnerOnlyRefusal = async (page: Page, gate: Gate, id: string, label: string) => {
    const answer = await probe(page, gate, id);
    expect(answer.status, `${label}: ${answer.text}`).toBe(403);
    expectNoTrace(answer, label);
  };

  test.beforeAll(
    withAssetReadySetup(async (signal) => {
      utils.initSdk();
      await utils.resetDatabase();
      admin = await utils.adminSetup();
      [owner, editor, viewer, revoked] = await Promise.all([
        utils.userSetup(admin.accessToken, createUserDto.user1),
        utils.userSetup(admin.accessToken, createUserDto.user2),
        utils.userSetup(admin.accessToken, createUserDto.user3),
        utils.userSetup(admin.accessToken, createUserDto.user4),
      ]);
      secretFileName = `fl112-secret-${randomUUID().slice(0, 8)}.png`;
      plain = await utils.createAsset(owner.accessToken, { assetData: { filename: 'fl112-plain.png' } });
      secret = await utils.createAsset(owner.accessToken, { assetData: { filename: secretFileName } });
      await utils.waitForAssetReady(admin.accessToken, plain.id, { headers: asBearerAuth(owner.accessToken), signal });
      await utils.waitForAssetReady(admin.accessToken, secret.id, { headers: asBearerAuth(owner.accessToken), signal });

      // the shared space: an album holding the plain item, with an editor, a viewer and a member to revoke
      // a shared space (album kind "space"): a project can only be shared with one of those
      const album = await utils.createAlbum(owner.accessToken, {
        albumName: 'FL-112 space',
        kind: AlbumKind.Space,
        assetIds: [plain.id],
        albumUsers: [
          { userId: editor.userId, role: AlbumUserRole.Editor },
          { userId: viewer.userId, role: AlbumUserRole.Viewer },
          { userId: revoked.userId, role: AlbumUserRole.Viewer },
        ],
      });
      spaceId = album.id;
      // a shared space invites; nobody is a member until they accept
      for (const member of [editor, viewer, revoked]) {
        await acceptSharedSpaceInvitation({ id: spaceId }, { headers: asBearerAuth(member.accessToken) });
      }

      // the Locked item, as the owner locks it; the owner's sessions stay locked afterwards
      const headers = asBearerAuth(owner.accessToken);
      const api = (path: string, method: string, body: unknown) =>
        fetch(`${app}${path}`, {
          method,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      for (const [path, body] of [
        ['/auth/pin-code', { pinCode }],
        ['/auth/session/unlock', { pinCode }],
        ['/assets/lock', { ids: [secret.id] }],
        ['/auth/session/lock', {}],
      ] as const) {
        const response = await api(path, 'POST', body);
        expect(response.status, path).toBe(204);
      }

      const create = async (name: string, clips: { assetId: string }[]) =>
        createStudioProject(
          {
            studioProjectCreateDto: {
              name,
              clientId: randomUUID(),
              requestKey: randomUUID(),
              spaceId,
              envelope: envelope(clips),
            } as never,
          },
          { headers },
        );
      const project = await create(PROJECT_NAME, [clip(plain.id)]);
      const sensitive = await create(SENSITIVE_NAME, [clip(plain.id), clip(secret.id)]);
      projectId = project.id;
      sensitiveId = sensitive.id;
    }),
  );

  test.afterAll(async () => {
    mkdirSync(dirname(OUT), { recursive: true });
    const report = { gates: GATES, cases: CASES, results };
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    await test.info().attach('studio-authorization-gates.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  });

  test('owner: every gate admits the owner', async ({ browser }) => {
    const page = await openAs(browser, owner);

    await record('project', 'owner', async () => {
      const opened = await call(page, 'GET', `/studio/projects/${projectId}`);
      expect(opened.status, opened.text).toBe(200);
      expect(JSON.parse(opened.text)).toMatchObject({ name: PROJECT_NAME, access: 'owner' });
      const renamed = await call(page, 'PUT', `/studio/projects/${projectId}`, { name: `${PROJECT_NAME} renamed` });
      expect(renamed.status, renamed.text).toBe(200);
      const restored = await call(page, 'PUT', `/studio/projects/${projectId}`, { name: PROJECT_NAME });
      expect(restored.status, restored.text).toBe(200);
      // and the browser opens it as the owner's project
      await page.goto(`/studio?project=${projectId}`);
      await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue(PROJECT_NAME);
    });
    await record('source', 'owner', async () => {
      const opened = await jsonOf(page, `/studio/projects/${projectId}`);
      expect(opened.resources).toMatchObject({ complete: true, refusedCount: 0 });
      expect(await statusOf(page, `/assets/${plain.id}/thumbnail`)).toBe(200);
    });
    await record('preview', 'owner', async () => {
      expectPreviewAdmitted(await probe(page, 'preview', projectId), 'owner preview');
    });
    await record('export', 'owner', async () => {
      const listed = await probe(page, 'export', projectId);
      expect(listed.status, listed.text).toBe(200);
    });
    await record('import', 'owner', async () => {
      const listed = await probe(page, 'import', projectId);
      expect(listed.status, listed.text).toBe(200);
    });
    await record('bundle', 'owner', async () => {
      const queued = await probe(page, 'bundle', projectId);
      expect(queued.status, queued.text).toBe(201);
    });
    await page.context().close();
  });

  for (const [scenario, member] of [
    ['shared', () => editor],
    ['viewer', () => viewer],
  ] as const) {
    test(`${scenario}: a space member reviews but never edits, exports, imports or bundles`, async ({ browser }) => {
      const page = await openAs(browser, member());
      // a refusal below is evidence only from a real member, so membership is checked first
      const reviewing = await call(page, 'GET', `/studio/projects/${projectId}`);
      expect(reviewing.status, `${scenario} is a member of the space: ${reviewing.text}`).toBe(200);

      await record('project', scenario, async () => {
        const opened = await call(page, 'GET', `/studio/projects/${projectId}`);
        expect(opened.status, opened.text).toBe(200);
        expect(JSON.parse(opened.text)).toMatchObject({ name: PROJECT_NAME, access: 'reviewer' });
        const renamed = await call(page, 'PUT', `/studio/projects/${projectId}`, { name: 'taken over' });
        expect(renamed.status, renamed.text).toBe(403);
        expectNoTrace({ ...renamed, text: renamed.text.replace(PROJECT_NAME, '') }, `${scenario} rename`);
        const again = await jsonOf(page, `/studio/projects/${projectId}`);
        expect(again.name).toBe(PROJECT_NAME);
        // the browser opens it for review only: the name as a heading, never the owner's rename box
        await page.goto(`/studio?project=${projectId}`);
        await expect(page.getByRole('heading', { level: 1, name: PROJECT_NAME })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveCount(0);
        await expect(page.getByText('View only')).toBeVisible();
      });
      await record('source', scenario, async () => {
        const opened = await jsonOf(page, `/studio/projects/${projectId}`);
        expect(opened.resources).toMatchObject({ complete: true, refusedCount: 0 });
        expect(await statusOf(page, `/assets/${plain.id}/thumbnail`)).toBe(200);
      });
      await record('preview', scenario, async () => {
        expectPreviewAdmitted(await probe(page, 'preview', projectId), `${scenario} preview`);
      });
      for (const gate of ['export', 'import', 'bundle'] as const) {
        await record(gate, scenario, () => expectOwnerOnlyRefusal(page, gate, projectId, `${scenario} ${gate}`));
      }
      await page.context().close();
    });
  }

  test('sensitive: a Locked source reaches no gate, for a locked owner or a member', async ({ browser }) => {
    const ownerPage = await openAs(browser, owner);
    const memberPage = await openAs(browser, editor);
    const reviewing = await call(memberPage, 'GET', `/studio/projects/${sensitiveId}`);
    expect(reviewing.status, `the member reviews the sensitive project: ${reviewing.text}`).toBe(200);

    await record('project', 'sensitive', async () => {
      const locked = await call(ownerPage, 'GET', `/studio/projects/${sensitiveId}`);
      expect(locked.status, locked.text).toBe(200);
      // the owner is told which of their own sources to hide; a member is told nothing about it
      expect(JSON.parse(locked.text).resources.hiddenSources).toEqual([secret.id]);
      const reviewed = await call(memberPage, 'GET', `/studio/projects/${sensitiveId}`);
      expect(reviewed.status, reviewed.text).toBe(200);
      for (const trace of [secret.id, secretFileName]) {
        expect(reviewed.text.includes(trace), `member project mentions ${trace}`).toBe(false);
      }
    });
    await record('source', 'sensitive', async () => {
      const locked = await jsonOf(ownerPage, `/studio/projects/${sensitiveId}`);
      expect(locked.resources).toMatchObject({ complete: false, refusedCount: 1 });
      expect(await statusOf(ownerPage, `/assets/${secret.id}/thumbnail`)).toBeGreaterThanOrEqual(400);
      expect(await statusOf(memberPage, `/assets/${secret.id}/thumbnail`)).toBeGreaterThanOrEqual(400);
    });
    await record('preview', 'sensitive', async () => {
      for (const [page, who] of [
        [ownerPage, 'locked owner'],
        [memberPage, 'member'],
      ] as const) {
        const answer = await probe(page, 'preview', sensitiveId);
        expect(answer.status, `${who}: ${answer.text}`).toBe(409);
        expect(JSON.parse(answer.text).code, who).toBe('studio_preview_sources_refused');
        for (const trace of [secret.id, secretFileName]) {
          expect(answer.text.includes(trace), `${who} preview mentions ${trace}`).toBe(false);
        }
      }
    });
    await record('export', 'sensitive', async () => {
      // a locked owner's export list holds nothing made from the Locked item; a member is refused outright
      const listed = await probe(ownerPage, 'export', sensitiveId);
      expect(listed.status, listed.text).toBe(200);
      expect(listed.text.includes(secretFileName)).toBe(false);
      await expectOwnerOnlyRefusal(memberPage, 'export', sensitiveId, 'member export');
    });
    await record('import', 'sensitive', async () => {
      const listed = await probe(ownerPage, 'import', sensitiveId);
      expect(listed.status, listed.text).toBe(200);
      expect(listed.text.includes(secretFileName)).toBe(false);
      await expectOwnerOnlyRefusal(memberPage, 'import', sensitiveId, 'member import');
    });
    await record('bundle', 'sensitive', async () => {
      await expectOwnerOnlyRefusal(memberPage, 'bundle', sensitiveId, 'member bundle');
    });
    await ownerPage.context().close();
    await memberPage.context().close();
  });

  test('revoked: a member removed from the space loses every gate at once', async ({ browser }) => {
    const page = await openAs(browser, revoked);
    // access existed: the member reviews the project before being removed
    const before = await call(page, 'GET', `/studio/projects/${projectId}`);
    expect(before.status, before.text).toBe(200);

    await removeUserFromAlbum({ id: spaceId, userId: revoked.userId }, { headers: asBearerAuth(owner.accessToken) });

    for (const gate of ['project', 'preview', 'export', 'import', 'bundle'] as const) {
      await record(gate, 'revoked', async () => {
        await expectRefusedLikeMissing(page, gate, projectId, `revoked ${gate}`);
        if (gate === 'project') {
          await page.goto(`/studio?project=${projectId}`);
          await page.waitForLoadState('networkidle');
          // neither the owner's rename box nor a reviewer's heading: the project is not shown at all
          await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveCount(0);
          await expect(page.getByRole('heading', { level: 1, name: PROJECT_NAME })).toHaveCount(0);
          const shown = await page.locator('body').innerText();
          expect(shown.includes(PROJECT_NAME)).toBe(false);
        }
      });
    }
    await record('source', 'revoked', async () => {
      expect(await statusOf(page, `/assets/${plain.id}/thumbnail`)).toBeGreaterThanOrEqual(400);
    });
    await page.context().close();
  });

  test('every gate and case was measured and passed', () => {
    const missingOrFailed = GATES.flatMap((gate) =>
      CASES.filter((scenario) => results[gate][scenario]?.result !== 'passed').map(
        (scenario) => `${gate}/${scenario}: ${results[gate][scenario]?.reason ?? 'not measured'}`,
      ),
    );
    expect(missingOrFailed).toEqual([]);
  });
});
