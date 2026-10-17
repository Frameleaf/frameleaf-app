import { params } from './params';

it('accepts UUID route values and rejects malformed identifiers', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  expect(params.id['~standard'].validate(id)).toEqual({ value: id });
  for (const invalid of ['', 'not-a-uuid', '../photos', `${id}/extra`]) {
    expect(params.id['~standard'].validate(invalid)).toHaveProperty('issues');
  }
});

it('accepts only the literal photos segment', () => {
  expect(params.photos['~standard'].validate('photos')).toEqual({ value: 'photos' });
  for (const invalid of ['', 'photo', 'Photos', 'photos/extra']) {
    expect(params.photos['~standard'].validate(invalid)).toHaveProperty('issues');
  }
});
