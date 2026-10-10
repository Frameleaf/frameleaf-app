import type { AssetDevelopResponseDto } from '@frameleaf/sdk';
import { nativePublicationState, nativeStrokeOverlay } from './native-editor-state';

it('ignores historical successes and waits through rendered-before-current publication', () => {
  const develop = {
    currentRevisionId: 'old',
    revisions: [
      { id: 'old', status: 'rendered' },
      { id: 'new', status: 'queued' },
    ],
  } as AssetDevelopResponseDto;
  expect(nativePublicationState(develop, 'new')).toEqual({
    published: false,
    awaitingPublication: false,
    terminal: false,
  });
  develop.revisions[1].status = 'rendered' as never;
  expect(nativePublicationState(develop, 'new')).toEqual({
    published: false,
    awaitingPublication: true,
    terminal: false,
  });
  develop.currentRevisionId = 'new';
  expect(nativePublicationState(develop, 'new').published).toBe(true);
  expect(nativePublicationState(develop, undefined).published).toBe(false);
  develop.revisions[1].status = 'failed' as never;
  expect(nativePublicationState(develop, 'new').terminal).toBe(true);
});
it('gives paint and erase the same circular shorter-edge radius on both aspects', () => {
  for (const [width, height] of [
    [1200, 800],
    [800, 1200],
  ]) {
    const stroke = {
      points: [
        [0.25, 0.5],
        [0.5, 0.5],
      ] as [number, number][],
      radius: 0.025,
    };
    expect(nativeStrokeOverlay(stroke, width, height)).toEqual({
      points: `${width / 4},${height / 2} ${width / 2},${height / 2}`,
      radius: 20,
      first: { x: width / 4, y: height / 2 },
    });
    expect(nativeStrokeOverlay({ ...stroke, points: [stroke.points[0]] }, width, height).radius).toBe(20);
  }
});
