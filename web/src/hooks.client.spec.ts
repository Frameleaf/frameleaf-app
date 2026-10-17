import { handleError } from './hooks.client';

const event = {} as Parameters<typeof handleError>[0]['event'];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

it('preserves framework error status and message', async () => {
  expect(await handleError({ kind: 'framework', error: { status: 404, message: 'Page not found' }, event })).toEqual({
    code: 404,
    status: 404,
    message: 'Page not found',
  });
});

it('preserves an application error status and message', async () => {
  expect(await handleError({ kind: 'app', error: { status: 403, message: 'Access denied' }, event })).toEqual({
    code: 403,
    status: 403,
    message: 'Access denied',
  });
});

it('keeps unexpected errors at 500 with the existing fallback', async () => {
  const result = await handleError({ kind: 'unknown', error: undefined, event });
  expect(result).toEqual({
    code: 500,
    status: 500,
    message: 'Something went wrong. Try again in a moment.',
  });
});
