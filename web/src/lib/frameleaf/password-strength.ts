/**
 * Password strength and requirements, ported from the design template's `passwordStrength` /
 * `passwordRequirements` (`system-data.mjs`). The meter is guidance for the person typing; the
 * server keeps its own validation.
 */
export type PasswordRuleId = 'length' | 'lower' | 'upper' | 'number' | 'symbol';

export const PASSWORD_RULES: readonly { id: PasswordRuleId; labelKey: string; test: (value: string) => boolean }[] =
  Object.freeze([
    { id: 'length', labelKey: 'frameleaf_password_rule_length', test: (value) => value.length >= 8 },
    { id: 'lower', labelKey: 'frameleaf_password_rule_lower', test: (value) => /[a-z]/.test(value) },
    { id: 'upper', labelKey: 'frameleaf_password_rule_upper', test: (value) => /[A-Z]/.test(value) },
    { id: 'number', labelKey: 'frameleaf_password_rule_number', test: (value) => /\d/.test(value) },
    { id: 'symbol', labelKey: 'frameleaf_password_rule_symbol', test: (value) => /[^\dA-Za-z\s]/.test(value) },
  ]);

export const STRENGTH_LABEL_KEYS = Object.freeze([
  'frameleaf_password_strength_empty',
  'frameleaf_password_strength_weak',
  'frameleaf_password_strength_fair',
  'frameleaf_password_strength_good',
  'frameleaf_password_strength_strong',
]);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type PasswordStrength = {
  /** 0 while empty, then 1 (weak) to 4 (strong). */
  score: number;
  labelKey: string;
  passed: number;
  total: number;
  checks: Record<PasswordRuleId, boolean>;
  /** At least three rules met, the prototype's bar for accepting a password. */
  acceptable: boolean;
};

export const passwordStrength = (password: string): PasswordStrength => {
  const value = typeof password === 'string' ? password : '';
  const checks = Object.fromEntries(PASSWORD_RULES.map((rule) => [rule.id, rule.test(value)])) as Record<
    PasswordRuleId,
    boolean
  >;
  const passed = Object.values(checks).filter(Boolean).length;
  let score = 0;
  if (value.length > 0) {
    score = checks.length ? clamp(passed - 1, 1, 4) : 1;
    if (checks.length && value.length >= 14) {
      score = clamp(score + 1, 1, 4);
    }
  }
  return {
    score,
    labelKey: STRENGTH_LABEL_KEYS[score],
    passed,
    total: PASSWORD_RULES.length,
    checks,
    acceptable: checks.length && passed >= 3,
  };
};
