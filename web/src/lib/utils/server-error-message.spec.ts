import { getServerErrorMessage } from '$lib/utils/handle-error';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  isHttpError: (error: unknown) => (error as { name?: string })?.name === 'HttpError',
}));

const failure = (data: unknown) => ({ name: 'HttpError', message: 'Request failed', status: 400, data });

it.each([
  { errors: [null] },
  { errors: [{ message: 'bad field' }] },
  { errors: [{ message: 'bad field', path: 'field' }] },
  { errors: [{ message: 'bad field', path: [null] }] },
  { errors: [{ message: {}, path: ['field'] }] },
])('retains the original failure for malformed details: $errors', ({ errors }) => {
  expect(getServerErrorMessage(failure({ message: 'Validation failed', errors }))).toBe('Validation failed');
});

it.each([{}, { message: 12 }, { message: {} }, 'not json', 'null', null])(
  'uses the transport message for an unusable response message: %s',
  (data) => expect(getServerErrorMessage(failure(data))).toBe('Request failed'),
);

it.each([false, true])('preserves valid nested and root details for JSON text=%s', (encoded) => {
  const data = {
    message: 'Validation failed',
    errors: [
      { path: ['items', 2, 'name'], message: 'Required' },
      { path: [0, 'value'], message: 'Invalid' },
      { path: [], message: 'Invalid request' },
    ],
  };
  expect(getServerErrorMessage(failure(encoded ? JSON.stringify(data) : data))).toBe(
    'Validation failed: items[2].name: Required, [0].value: Invalid, Invalid request',
  );
});

it('retains valid details when another detail is malformed', () => {
  expect(
    getServerErrorMessage(failure({ message: 'Invalid', errors: [null, { path: ['name'], message: 'Required' }] })),
  ).toBe('Invalid: name: Required');
});

it('preserves an explicitly empty title for valid detail responses', () => {
  expect(getServerErrorMessage(failure({ message: '', errors: [{ path: [], message: 'Required' }] }))).toBe(
    ': Required',
  );
});

it('uses the transport title when valid details arrive without a server title', () => {
  expect(getServerErrorMessage(failure({ errors: [{ path: ['name'], message: 'Required' }] }))).toBe(
    'Request failed: name: Required',
  );
});

it('does not turn non-HTTP failures into server messages', () => {
  expect(getServerErrorMessage(new Error('local'))).toBeUndefined();
});
