import { BrowserContext, Route } from '@playwright/test';
import { randomThumbnail } from 'src/ui/generators/timeline.js';

// Minimal valid H.264 MP4 (8x8px, 1 frame) that browsers can decode to get videoWidth/videoHeight
const MINIMAL_MP4_BASE64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr9tZGF0AAACoAYF//+c' +
  '3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDEyNSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMg' +
  'LSBDb3B5bGVmdCAyMDAzLTIwMTIgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwg' +
  'LSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMg' +
  'bWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5n' +
  'ZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEg' +
  'ZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz02IGxvb2thaGVhZF90aHJl' +
  'YWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJh' +
  'eV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2Fk' +
  'YXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtl' +
  'eWludD0yNTAga2V5aW50X21pbj0yNCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9v' +
  'a2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBt' +
  'YXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA9liIQAV/0TAAYdeBTX' +
  'zg8AAALvbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACoAAQAAAQAAAAAAAAAAAAAAAAEAAAAA' +
  'AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAA' +
  'Ahl0cmFrAAAAXHRraGQAAAAPAAAAAAAAAAAAAAABAAAAAAAAACoAAAAAAAAAAAAAAAAAAAAAAAEAAAAA' +
  'AAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAgAAAAIAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA' +
  'AAEAAAAqAAAAAAABAAAAAAGRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAAgBVxAAAAAAA' +
  'LWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABPG1pbmYAAAAUdm1oZAAA' +
  'AAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAPxzdGJsAAAAmHN0' +
  'c2QAAAAAAAAAAQAAAIhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAgACABIAAAASAAAAAAAAAAB' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAMmF2Y0MBZAAK/+EAGWdkAAqs' +
  '2V+WXAWyAAADAAIAAAMAYB4kSywBAAZo6+PLIsAAAAAYc3R0cwAAAAAAAAABAAAAAQAAAgAAAAAcc3Rz' +
  'YwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACtwAAAAEAAAAUc3RjbwAAAAAAAAABAAAA' +
  'MAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWls' +
  'c3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNTQuNjMuMTA0';

export const MINIMAL_MP4_BUFFER = Buffer.from(MINIMAL_MP4_BASE64, 'base64');

export type MockPerson = {
  id: string;
  name: string;
  birthDate: string | null;
  isHidden: boolean;
  thumbnailPath: string;
  updatedAt: string;
};

export const createMockPeople = (count: number): MockPerson[] => {
  const names = [
    'Alice Johnson',
    'Bob Smith',
    'Charlie Brown',
    'Diana Prince',
    'Eve Adams',
    'Frank Castle',
    'Grace Lee',
    'Hank Pym',
    'Iris West',
    'Jack Ryan',
  ];
  return Array.from({ length: count }, (_, index) => ({
    id: `person-${index}`,
    name: names[index % names.length],
    birthDate: null,
    isHidden: false,
    thumbnailPath: `/upload/thumbs/person-${index}.jpeg`,
    updatedAt: '2025-01-01T00:00:00.000Z',
  }));
};

export type FaceCreateCapture = {
  requests: Array<{
    assetId: string;
    personId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    imageWidth: number;
    imageHeight: number;
  }>;
  /** `POST /api/people` bodies, from the face tagger's "Create person" form. */
  people: Array<{ name: string }>;
};

/** FL-38: a face as `GET /api/faces` lists it, with its revision and provenance. */
export type MockFace = {
  id: string;
  imageWidth: number;
  imageHeight: number;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  sourceType: 'machine-learning' | 'manual';
  revision: string;
  correctedAt: string | null;
  hiddenAt: string | null;
  person: MockPerson | null;
};

export const createMockDetectedFace = (person: MockPerson | null, id = 'detected-face-1'): MockFace => ({
  id,
  imageWidth: 1000,
  imageHeight: 800,
  boundingBoxX1: 100,
  boundingBoxY1: 80,
  boundingBoxX2: 300,
  boundingBoxY2: 280,
  sourceType: 'machine-learning',
  revision: `${id}-rev-1`,
  correctedAt: null,
  hiddenAt: null,
  person,
});

/**
 * FL-38: what the mocked face endpoints hold and how they answer. `conflictOnCorrect` and
 * `conflictOnCreate` make the next correction or face creation fail with 409, as the server does
 * when another editor changed the face or the image changed since the dialog read it.
 */
export type FaceTaggerMockState = {
  faces: MockFace[];
  sourceRevision: string;
  /** The source revision `GET /api/faces/source` answers once a conflict was served. */
  sourceRevisionAfterConflict?: string;
  conflictOnCorrect?: boolean;
  conflictOnCreate?: boolean;
  corrections: Array<{ id: string; body: Record<string, unknown> }>;
  deletes: Array<{ id: string; body: Record<string, unknown> }>;
  faceReads: number;
};

export const createFaceTaggerMockState = (faces: MockFace[] = []): FaceTaggerMockState => ({
  faces,
  sourceRevision: 'source-rev-1',
  corrections: [],
  deletes: [],
  faceReads: 0,
});

/** The server's answer to a stale correction or a box drawn on an image that changed since. */
const conflict = (route: Route) =>
  route.fulfill({
    status: 409,
    contentType: 'application/json',
    json: { message: 'This face changed in another view.', statusCode: 409, error: 'Conflict' },
  });

/**
 * FL-38: the routes the Frameleaf face tagger (`FaceTagger.svelte`) calls — the asset's
 * existing faces and their source revision, the people to choose from, and the batch save's
 * person creates, face creates, revision-checked corrections and removals.
 */
export const setupFaceTaggerMockApiRoutes = async (
  context: BrowserContext,
  mockPeople: MockPerson[],
  faceCreateCapture: FaceCreateCapture,
  state: FaceTaggerMockState = createFaceTaggerMockState(),
) => {
  await context.route('**/api/people?*', async (route, request) => {
    if (request.method() !== 'GET') {
      return route.fallback();
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: {
        hasNextPage: false,
        hidden: 0,
        people: mockPeople,
        total: mockPeople.length,
      },
    });
  });

  await context.route('**/api/people', async (route, request) => {
    if (request.method() !== 'POST') {
      return route.fallback();
    }

    const body = request.postDataJSON() as { name: string };
    faceCreateCapture.people.push(body);
    const person: MockPerson = {
      id: `created-person-${faceCreateCapture.people.length}`,
      name: body.name,
      birthDate: null,
      isHidden: false,
      thumbnailPath: '',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    return route.fulfill({ status: 201, contentType: 'application/json', json: person });
  });

  await context.route(/\/api\/faces\?/, async (route, request) => {
    if (request.method() !== 'GET') {
      return route.fallback();
    }

    state.faceReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', json: state.faces });
  });

  await context.route(/\/api\/faces\/source\?/, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: { assetId: new URL(route.request().url()).searchParams.get('id'), revision: state.sourceRevision },
    });
  });

  await context.route(/\/api\/faces$/, async (route, request) => {
    if (request.method() !== 'POST') {
      return route.fallback();
    }

    const body = request.postDataJSON();
    faceCreateCapture.requests.push(body);
    if (state.conflictOnCreate) {
      state.conflictOnCreate = false;
      state.sourceRevision = state.sourceRevisionAfterConflict ?? state.sourceRevision;
      return conflict(route);
    }

    const face: MockFace = {
      ...createMockDetectedFace(mockPeople.find((person) => person.id === body.personId) ?? null),
      id: `manual-face-${faceCreateCapture.requests.length}`,
      sourceType: 'manual',
    };
    return route.fulfill({ status: 201, contentType: 'application/json', json: face });
  });

  await context.route(/\/api\/faces\/[^/?]+$/, async (route, request) => {
    const id = new URL(request.url()).pathname.split('/').at(-1)!;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (request.method() === 'DELETE') {
      state.deletes.push({ id, body });
      return route.fulfill({ status: 204 });
    }
    if (request.method() !== 'PATCH') {
      return route.fallback();
    }

    state.corrections.push({ id, body });
    if (state.conflictOnCorrect) {
      state.conflictOnCorrect = false;
      return conflict(route);
    }
    const face = state.faces.find((row) => row.id === id) ?? createMockDetectedFace(null, id);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: { ...face, revision: `${id}-rev-2`, correctedAt: '2026-09-25T00:00:00.000Z' },
    });
  });

  await context.route('**/api/people/*/thumbnail', async (route) => {
    if (!route.request().serviceWorker()) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: await randomThumbnail('person-thumb', 1),
    });
  });
};
