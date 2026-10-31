import { AdminOnboardingResponseDto, AdminOnboardingUpdateDto } from 'src/dtos/system-metadata.dto.js';

it.each([true, false])('keeps onboarding request and response values compatible for %s', (isOnboarded) => {
  const value = { isOnboarded };
  expect(AdminOnboardingUpdateDto.schema.parse(value)).toEqual(value);
  expect(AdminOnboardingResponseDto.schema.parse(value)).toEqual(value);
});

it('keeps validation required and API schema identities separate', () => {
  for (const schema of [AdminOnboardingUpdateDto.schema, AdminOnboardingResponseDto.schema]) {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ isOnboarded: 'true' }).success).toBe(false);
  }
  expect(AdminOnboardingUpdateDto.schema.meta()?.id).toBe('AdminOnboardingUpdateDto');
  expect(AdminOnboardingResponseDto.schema.meta()?.id).toBe('AdminOnboardingResponseDto');
});
