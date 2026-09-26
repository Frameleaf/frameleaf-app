import { expect, Locator, Page, test } from '@playwright/test';
import { SeededRandom, selectRandom, TimelineAssetConfig } from 'src/ui/generators/timeline.js';
import {
  createFaceTaggerMockState,
  createMockDetectedFace,
  createMockPeople,
  FaceCreateCapture,
  FaceTaggerMockState,
  MockPerson,
  setupFaceTaggerMockApiRoutes,
} from 'src/ui/mock-network/face-editor-network';
import { assetViewerUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

/**
 * FL-38 (V-28): the Frameleaf face tagger dialog (FaceTagger.jsx), opened from the info
 * panel's People "Add" button. It replaced the legacy fabric-canvas overlay.
 */
const openFaceTagger = async (page: Page, asset: TimelineAssetConfig) => {
  await page.goto(`/photos/${asset.id}`);
  await assetViewerUtils.waitForViewerLoad(page, asset);
  await page.keyboard.press('i');
  await page.locator('#detail-panel').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Add person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tag people' });
  await expect(dialog).toBeVisible();
  // The toolbar enables once the preview has loaded and been measured.
  await expect(dialog.getByRole('button', { name: 'Add face' })).toBeEnabled();
  return dialog;
};

const addFace = async (dialog: Locator) => {
  await dialog.getByRole('button', { name: 'Add face' }).click();
};

test.describe.configure({ mode: 'parallel' });
test.describe('face tagger', () => {
  const fixture = setupAssetViewerFixture(777);
  const rng = new SeededRandom(777);
  let mockPeople: MockPerson[];
  let faceCreateCapture: FaceCreateCapture;
  let faceState: FaceTaggerMockState;

  test.beforeAll(async () => {
    mockPeople = createMockPeople(8);
  });

  test.beforeEach(async ({ context }) => {
    faceCreateCapture = { requests: [], people: [] };
    faceState = createFaceTaggerMockState();
    await setupFaceTaggerMockApiRoutes(context, mockPeople, faceCreateCapture, faceState);
  });

  const pickAsset = () => selectRandom(fixture.assets, rng);

  test('opens with the file name, drawing mode and the empty-state guidance', async ({ page }) => {
    const asset = pickAsset();
    const dialog = await openFaceTagger(page, asset);

    await expect(dialog.getByRole('heading', { name: 'Tag people' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Draw face', pressed: true })).toBeVisible();
    await expect(dialog.getByText('0 faces')).toBeVisible();
    await expect(dialog.getByText('Add a missing face')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save face tags' })).toBeEnabled();
  });

  test('Add face selects a new region and lists every person', async ({ page }) => {
    const dialog = await openFaceTagger(page, pickAsset());

    await addFace(dialog);

    await expect(dialog.getByText('1 face', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Choose a person for every face.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save face tags' })).toBeDisabled();
    for (const person of mockPeople) {
      await expect(dialog.getByRole('button', { name: person.name })).toBeVisible();
    }
  });

  test('Search filters people by name', async ({ page }) => {
    const dialog = await openFaceTagger(page, pickAsset());
    await addFace(dialog);

    const search = dialog.getByRole('searchbox', { name: 'Find a person' });
    await search.fill('Alice');
    await expect(dialog.getByRole('button', { name: 'Alice Johnson' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Bob Smith' })).toBeHidden();

    await search.fill('Nonexistent Person XYZ');
    await expect(dialog.getByText('No matching people.')).toBeVisible();
  });

  test('dragging on the photo draws a face region', async ({ page }) => {
    const dialog = await openFaceTagger(page, pickAsset());
    const stage = dialog.getByRole('application', { name: 'Photo face regions' });
    const box = await stage.boundingBox();
    if (!box) {
      throw new Error('Face tagger stage not found');
    }
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    await page.mouse.move(centerX - 40, centerY - 40);
    await page.mouse.down();
    await page.mouse.move(centerX + 40, centerY + 40, { steps: 5 });
    await page.mouse.up();

    await expect(dialog.getByText('1 face', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Draw face', pressed: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Face 1: Choose a person$/ })).toBeVisible();
  });

  test('numeric inputs and arrow keys move the selected region, and Undo reverts', async ({ page }) => {
    const dialog = await openFaceTagger(page, pickAsset());
    await addFace(dialog);
    const left = dialog.getByRole('spinbutton', { name: 'Left (%)' });
    await expect(left).toHaveValue('35');

    await left.fill('10');
    await expect(left).toHaveValue('10');

    await dialog.getByRole('application', { name: 'Photo face regions' }).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(left).toHaveValue('12');

    await dialog.getByRole('button', { name: 'Undo' }).click();
    await expect(left).toHaveValue('10');
  });

  test('saving a tagged region calls createFace and closes the dialog', async ({ page }) => {
    const asset = pickAsset();
    const dialog = await openFaceTagger(page, asset);
    await addFace(dialog);

    const personToTag = mockPeople[0];
    await dialog.getByRole('button', { name: personToTag.name }).click();
    await expect(dialog.getByText('Changes are ready to save.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save face tags' }).click();

    await expect(dialog).toBeHidden();
    expect(faceCreateCapture.requests).toHaveLength(1);
    expect(faceCreateCapture.requests[0].assetId).toBe(asset.id);
    expect(faceCreateCapture.requests[0].personId).toBe(personToTag.id);
    expect(faceCreateCapture.requests[0].width).toBeGreaterThan(0);
    expect(faceCreateCapture.requests[0].imageWidth).toBeGreaterThan(0);
  });

  test('several regions save in one batch, including a person created in the dialog', async ({ page }) => {
    const dialog = await openFaceTagger(page, pickAsset());
    await addFace(dialog);
    await dialog.getByRole('button', { name: mockPeople[1].name }).click();

    await addFace(dialog);
    await dialog.getByRole('button', { name: 'Create person' }).click();
    await dialog.getByRole('textbox', { name: "New person's name" }).fill('Zoe Quinn');
    await dialog.getByRole('button', { name: 'Create and assign' }).click();
    await expect(dialog.getByText('2 faces')).toBeVisible();
    expect(faceCreateCapture.people).toHaveLength(0);

    await dialog.getByRole('button', { name: 'Save face tags' }).click();

    await expect(dialog).toBeHidden();
    expect(faceCreateCapture.people).toEqual([{ name: 'Zoe Quinn' }]);
    const personIds = faceCreateCapture.requests.map((request) => request.personId);
    expect(personIds).toHaveLength(2);
    expect(personIds).toEqual(expect.arrayContaining(['created-person-1', mockPeople[1].id]));
  });

  test('Remove face drops the selected region', async ({ page }) => {
    const dialog = await openFaceTagger(page, pickAsset());
    await addFace(dialog);
    await expect(dialog.getByText('1 face', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Remove face' }).click();

    await expect(dialog.getByText('0 faces')).toBeVisible();
  });

  test('Cancel and Escape close the dialog without saving', async ({ page }) => {
    const asset = pickAsset();
    let dialog = await openFaceTagger(page, asset);
    await addFace(dialog);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Add person' }).click();
    dialog = page.getByRole('dialog', { name: 'Tag people' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Escape stays inside the dialog: the viewer itself is still open.
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();

    expect(faceCreateCapture.requests).toHaveLength(0);
  });

  test.describe('existing faces (FL-38 corrections)', () => {
    test.beforeEach(() => {
      faceState.faces = [createMockDetectedFace(mockPeople[0])];
    });

    test('a detected face shows its provenance and is reassigned at the revision it was read', async ({ page }) => {
      const dialog = await openFaceTagger(page, pickAsset());
      const faces = dialog.getByRole('group', { name: 'Faces in this image' });
      await expect(faces).toContainText(mockPeople[0].name);
      await expect(faces).toContainText('Detected');
      // detected faces can be placed with the position fields too
      await expect(dialog.getByRole('spinbutton', { name: 'Left (%)' })).toBeEnabled();

      await dialog.getByRole('button', { name: mockPeople[1].name }).click();
      await dialog.getByRole('button', { name: 'Save face tags' }).click();

      await expect(dialog).toBeHidden();
      expect(faceState.corrections).toEqual([
        {
          id: 'detected-face-1',
          body: { expectedRevision: 'detected-face-1-rev-1', personId: mockPeople[1].id },
        },
      ]);
    });

    test('a detected face can be given a person created in the dialog', async ({ page }) => {
      const dialog = await openFaceTagger(page, pickAsset());

      await dialog.getByRole('button', { name: 'Create person' }).click();
      await dialog.getByRole('textbox', { name: "New person's name" }).fill('Zoe Quinn');
      await dialog.getByRole('button', { name: 'Create and assign' }).click();
      await dialog.getByRole('button', { name: 'Save face tags' }).click();

      await expect(dialog).toBeHidden();
      expect(faceCreateCapture.people).toEqual([{ name: 'Zoe Quinn' }]);
      expect(faceState.corrections).toEqual([
        { id: 'detected-face-1', body: { expectedRevision: 'detected-face-1-rev-1', personId: 'created-person-1' } },
      ]);
    });

    test('a detected face moved with the keyboard is saved as a box correction on the same image', async ({ page }) => {
      const dialog = await openFaceTagger(page, pickAsset());

      await dialog.getByRole('application', { name: 'Photo face regions' }).focus();
      await page.keyboard.press('Shift+ArrowDown');
      await expect(dialog.getByRole('group', { name: 'Faces in this image' })).toContainText('Corrected by you');
      await dialog.getByRole('button', { name: 'Save face tags' }).click();

      await expect(dialog).toBeHidden();
      expect(faceState.corrections).toHaveLength(1);
      expect(faceState.corrections[0].body).toEqual(
        expect.objectContaining({
          expectedRevision: 'detected-face-1-rev-1',
          expectedSourceRevision: 'source-rev-1',
          box: expect.objectContaining({ imageWidth: expect.any(Number), imageHeight: expect.any(Number) }),
        }),
      );
    });

    test('a conflicting save keeps the draft behind the stale banner until the latest faces load', async ({ page }) => {
      faceState.conflictOnCorrect = true;
      const dialog = await openFaceTagger(page, pickAsset());
      await dialog.getByRole('button', { name: mockPeople[2].name }).click();
      await dialog.getByRole('button', { name: 'Save face tags' }).click();

      await expect(dialog.getByText('Face tags changed in another view.')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Save face tags' })).toBeDisabled();
      // The kept draft names the person on the face box, its row and the people list; the list's
      // choice is the one that stays pressed.
      await expect(dialog.getByRole('button', { name: mockPeople[2].name, exact: true, pressed: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: `Face 1: ${mockPeople[2].name}` })).toBeVisible();

      faceState.faces = [{ ...createMockDetectedFace(mockPeople[3]), revision: 'detected-face-1-rev-9' }];
      const reads = faceState.faceReads;
      await dialog.getByRole('button', { name: 'Discard changes and load latest' }).click();

      await expect(dialog.getByText('Face tags changed in another view.')).toBeHidden();
      expect(faceState.faceReads).toBeGreaterThan(reads);
      await expect(dialog.getByRole('group', { name: 'Faces in this image' })).toContainText(mockPeople[3].name);
    });

    test('a new region drawn before the image changed is refused and kept', async ({ page }) => {
      faceState.conflictOnCreate = true;
      faceState.sourceRevisionAfterConflict = 'source-rev-2';
      const dialog = await openFaceTagger(page, pickAsset());
      await addFace(dialog);
      await dialog.getByRole('button', { name: mockPeople[1].name }).click();
      await dialog.getByRole('button', { name: 'Save face tags' }).click();

      await expect(dialog.getByText(/This image changed since you opened it/)).toBeVisible();
      await expect(dialog.getByText('2 faces')).toBeVisible();
      expect(faceCreateCapture.requests[0]).toEqual(
        expect.objectContaining({ expectedSourceRevision: 'source-rev-1', personId: mockPeople[1].id }),
      );
    });
  });

  test('the dialog closes when the unlocked session is concealed (relock) while it is open', async ({
    context,
    page,
  }) => {
    // An elevated session: the tagger follows sessionAccess and closes once the view is concealed.
    await context.route('**/api/auth/status', (route) =>
      route.fulfill({
        headers: { date: new Date().toUTCString() },
        json: {
          isElevated: true,
          password: true,
          pinCode: true,
          pinExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      }),
    );
    const dialog = await openFaceTagger(page, pickAsset());

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(dialog).toBeHidden();
    expect(faceCreateCapture.requests).toHaveLength(0);
  });
});
