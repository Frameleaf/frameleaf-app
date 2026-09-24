/** Prototype password feedback; the API remains the authority for acceptance. */
export const passwordRequirements = [
  { id: 'length', label: 'At least 8 characters', test: (value: string) => value.length >= 8 },
  { id: 'lower', label: 'A lowercase letter', test: (value: string) => /[a-z]/.test(value) },
  { id: 'upper', label: 'An uppercase letter', test: (value: string) => /[A-Z]/.test(value) },
  { id: 'number', label: 'A number', test: (value: string) => /\d/.test(value) },
  { id: 'symbol', label: 'A symbol', test: (value: string) => /[^A-Za-z0-9\s]/.test(value) },
] as const;

const labels = ['Enter a password', 'Weak', 'Fair', 'Good', 'Strong'] as const;

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
  return { checks, score, label: labels[score], acceptable: meetsLength && passed >= 3 };
};
