import {
  findTileImage,
  findViewerHero,
  HERO_EASING_PROPERTY,
  HERO_TRANSITION_NAME,
  viewerZoomTransition,
  zoomDirection,
  type ZoomNavigation,
} from '$lib/frameleaf/viewer-zoom';

const { reducedMotion } = vi.hoisted(() => ({ reducedMotion: { value: false } }));
vi.mock('$lib/frameleaf/motion', () => ({ prefersReducedMotion: () => reducedMotion.value }));

const ROUTE = '/(user)/photos/[[assetId=id]]';
const grid = { route: { id: ROUTE }, params: {} };
const viewer = (assetId: string) => ({ route: { id: ROUTE }, params: { assetId } });

const onScreen = (element: Element) => {
  element.getBoundingClientRect = () =>
    ({ top: 10, left: 10, bottom: 110, right: 110, width: 100, height: 100 }) as DOMRect;
};

const addTile = (assetId: string) => {
  const tile = document.createElement('div');
  tile.dataset.assetId = assetId;
  const image = document.createElement('img');
  tile.append(image);
  document.body.append(tile);
  onScreen(image);
  return image;
};

const addViewer = () => {
  const section = document.createElement('section');
  section.id = 'immich-asset-viewer';
  section.innerHTML = '<div data-viewer-content><div data-viewer-hero></div></div>';
  document.body.append(section);
  const hero = section.querySelector<HTMLElement>('[data-viewer-hero]')!;
  onScreen(hero);
  return hero;
};

const navigation = (from: ZoomNavigation['from'], to: ZoomNavigation['to']): ZoomNavigation => ({
  from,
  to,
  complete: Promise.resolve(),
});

describe('zoomDirection', () => {
  it('opens from the grid into the viewer and closes back out', () => {
    expect(zoomDirection(grid, viewer('a'))).toEqual({ kind: 'open', assetId: 'a' });
    expect(zoomDirection(viewer('a'), grid)).toEqual({ kind: 'close', assetId: 'a' });
  });

  it('does nothing between two items or two grid pages', () => {
    expect(zoomDirection(viewer('a'), viewer('b'))).toBeNull();
    expect(zoomDirection(grid, grid)).toBeNull();
    expect(zoomDirection(null, grid)).toBeNull();
  });
});

describe('the zoom elements', () => {
  afterEach(() => document.body.replaceChildren());

  it('finds the tile image but never a copy inside the viewer', () => {
    const image = addTile('a');
    const inViewer = document.createElement('div');
    inViewer.id = 'immich-asset-viewer';
    inViewer.dataset.assetId = 'a';
    document.body.prepend(inViewer);
    expect(findTileImage('a')).toBe(image);
    expect(findTileImage('b')).toBeNull();
  });

  it('skips a tile that is off screen', () => {
    const image = addTile('a');
    image.getBoundingClientRect = () =>
      ({ top: -500, left: 0, bottom: -400, right: 100, width: 100, height: 100 }) as DOMRect;
    expect(findTileImage('a')).toBeNull();
  });

  it('finds the viewer’s fitted photo', () => {
    const hero = addViewer();
    expect(findViewerHero()).toBe(hero);
  });
});

describe('viewerZoomTransition', () => {
  let started: (() => Promise<void>) | undefined;
  let finish: () => void;

  beforeEach(() => {
    reducedMotion.value = false;
    started = undefined;
    Reflect.set(document, 'startViewTransition', (update: () => Promise<void>) => {
      started = update;
      return { finished: new Promise<void>((resolve) => (finish = resolve)) };
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition');
    document.body.replaceChildren();
  });

  it('pairs the tile with the viewer photo when opening, then clears both names', async () => {
    const tile = addTile('a');
    tile.style.setProperty('--fl-spring', 'linear(0, 1)');
    const pending = viewerZoomTransition(navigation(grid, viewer('a')));
    expect(pending).toBeInstanceOf(Promise);
    expect(tile.style.getPropertyValue('view-transition-name')).toBe(HERO_TRANSITION_NAME);
    expect(document.documentElement.style.getPropertyValue(HERO_EASING_PROPERTY)).toBe('linear(0, 1)');

    const hero = addViewer();
    await started!();
    await pending;
    expect(tile.style.getPropertyValue('view-transition-name')).toBe('');
    expect(hero.style.getPropertyValue('view-transition-name')).toBe(HERO_TRANSITION_NAME);

    finish();
    await vi.waitFor(() => expect(hero.style.getPropertyValue('view-transition-name')).toBe(''));
    expect(document.documentElement.style.getPropertyValue(HERO_EASING_PROPERTY)).toBe('');
  });

  it('shrinks the viewer photo back into its tile when closing', async () => {
    const hero = addViewer();
    const pending = viewerZoomTransition(navigation(viewer('a'), grid));
    expect(hero.style.getPropertyValue('view-transition-name')).toBe(HERO_TRANSITION_NAME);

    const tile = addTile('a');
    await started!();
    await pending;
    expect(hero.style.getPropertyValue('view-transition-name')).toBe('');
    expect(tile.style.getPropertyValue('view-transition-name')).toBe(HERO_TRANSITION_NAME);
  });

  it('is instant under Reduce Motion, checked in JavaScript', () => {
    addTile('a');
    reducedMotion.value = true;
    expect(viewerZoomTransition(navigation(grid, viewer('a')))).toBeUndefined();
    expect(started).toBeUndefined();
  });

  it('is instant without the View Transitions API or a tile to grow from', () => {
    expect(viewerZoomTransition(navigation(grid, viewer('a')))).toBeUndefined();
    Reflect.deleteProperty(document, 'startViewTransition');
    addTile('a');
    expect(viewerZoomTransition(navigation(grid, viewer('a')))).toBeUndefined();
  });

  it('leaves next and previous inside the viewer alone', () => {
    addViewer();
    expect(viewerZoomTransition(navigation(viewer('a'), viewer('b')))).toBeUndefined();
  });
});
