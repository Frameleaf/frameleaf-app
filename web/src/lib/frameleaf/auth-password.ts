/**
 * The password rule (FL-708, UI review item 19): one rule, length. A password needs at least
 * `MIN_PASSWORD_LENGTH` characters and nothing else; letters, numbers and symbols only lift the
 * strength meter, so a long passphrase is as good as a short mix. The server enforces the same
 * minimum wherever a person chooses a password (`server/src/dtos/auth.dto.ts` `MIN_PASSWORD_LENGTH`).
 */
export const MIN_PASSWORD_LENGTH = 12;

export const passwordRequirements = [
  {
    id: 'length',
    label: 'frameleaf_auth_password_rule_length',
    test: (value: string) => value.length >= MIN_PASSWORD_LENGTH,
  },
] as const;

const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/] as const;

const labels = [
  'frameleaf_auth_password_strength_empty',
  'frameleaf_auth_password_strength_weak',
  'frameleaf_auth_password_strength_fair',
  'frameleaf_auth_password_strength_good',
  'frameleaf_auth_password_strength_strong',
] as const;

/**
 * Below the minimum reads as weak; at it, fair; a longer password or a mix of three kinds of
 * character reads as good; 20 characters, or 16 with two kinds, reads as strong.
 */
export const passwordStrength = (value: string) => {
  const checks = Object.fromEntries(passwordRequirements.map(({ id, test }) => [id, test(value)])) as Record<
    (typeof passwordRequirements)[number]['id'],
    boolean
  >;
  const acceptable = checks['length'];
  const kinds = variety.filter((pattern) => pattern.test(value)).length;
  let score = 0;
  if (value.length > 0) {
    score = acceptable ? 2 : 1;
    if (acceptable && (value.length >= 16 || kinds >= 3)) {
      score = 3;
    }
    if (acceptable && ((value.length >= 16 && kinds >= 2) || value.length >= 20)) {
      score = 4;
    }
  }
  // `label` is an i18n key; `acceptable` is the one rule the server enforces.
  return { checks, score, label: labels[score], acceptable };
};
