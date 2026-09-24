/**
 * Prototype password feedback. The meter is advisory only: the API remains the authority for which
 * passwords it accepts, so no screen blocks submission on these rules.
 */
export const passwordRequirements = [
  { id: 'length', label: 'frameleaf_auth_password_rule_length', test: (value: string) => value.length >= 8 },
  { id: 'lower', label: 'frameleaf_auth_password_rule_lower', test: (value: string) => /[a-z]/.test(value) },
  { id: 'upper', label: 'frameleaf_auth_password_rule_upper', test: (value: string) => /[A-Z]/.test(value) },
  { id: 'number', label: 'frameleaf_auth_password_rule_number', test: (value: string) => /\d/.test(value) },
  { id: 'symbol', label: 'frameleaf_auth_password_rule_symbol', test: (value: string) => /[^A-Za-z0-9\s]/.test(value) },
] as const;

const labels = [
  'frameleaf_auth_password_strength_empty',
  'frameleaf_auth_password_strength_weak',
  'frameleaf_auth_password_strength_fair',
  'frameleaf_auth_password_strength_good',
  'frameleaf_auth_password_strength_strong',
] as const;

export const passwordStrength = (value: string) => {
  const checks = Object.fromEntries(passwordRequirements.map(({ id, test }) => [id, test(value)])) as Record<
    (typeof passwordRequirements)[number]['id'],
    boolean
  >;
  const passed = Object.values(checks).filter(Boolean).length;
  const meetsLength = checks['length'];
  let score = value.length > 0 ? Math.min(4, Math.max(1, passed - 1)) : 0;
  if (value.length >= 14 && meetsLength) {
    score = Math.min(4, score + 1);
  }
  // `label` is an i18n key; `recommended` only colours the meter.
  return { checks, score, label: labels[score], recommended: meetsLength && passed >= 3 };
};
