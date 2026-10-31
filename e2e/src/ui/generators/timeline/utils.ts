import { DateTime } from 'luxon';
import { GENERATION_CONSTANTS } from 'src/ui/generators/timeline/timeline-config.js';

/**
 * Linear Congruential Generator for deterministic pseudo-random numbers
 */
export class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /**
   * Generate next random number in range [0, 1)
   */
  next(): number {
    // LCG parameters from Numerical Recipes
    this.seed = (this.seed * 1_664_525 + 1_013_904_223) % 2_147_483_647;
    return this.seed / 2_147_483_647;
  }

  /**
   * Generate random integer in range [min, max)
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }

  /**
   * Generate random boolean with given probability
   */
  nextBoolean(probability = 0.5): boolean {
    return this.next() < probability;
  }
}

/**
 * Select random days using seed variation to avoid collisions.
 *
 * @param daysInMonth - Total number of days in the month
 * @param numDays - Number of days to select
 * @param rng - Random number generator instance
 * @returns Array of selected day numbers, sorted in descending order
 */
export function selectRandomDays(daysInMonth: number, numDays: number, rng: SeededRandom): number[] {
  const selectedDays = new Set<number>();
  const maxAttempts = numDays * GENERATION_CONSTANTS.MAX_SELECT_ATTEMPTS; // Safety limit
  let attempts = 0;

  while (selectedDays.size < numDays && attempts < maxAttempts) {
    const day = rng.nextInt(1, daysInMonth + 1);
    selectedDays.add(day);
    attempts++;
  }

  // Fallback: if we couldn't select enough random days, fill with sequential days
  if (selectedDays.size < numDays) {
    for (let day = 1; day <= daysInMonth && selectedDays.size < numDays; day++) {
      selectedDays.add(day);
    }
  }

  return [...selectedDays].toSorted((a, b) => b - a);
}

/**
 * Select item from array using seeded random
 */
export function selectRandom<T>(arr: T[], rng: SeededRandom): T {
  if (arr.length === 0) {
    throw new Error('Cannot select from empty array');
  }
  const index = rng.nextInt(0, arr.length);
  return arr[index];
}

/**
 * Select multiple random items from array using seeded random without duplicates
 */
export function selectRandomMultiple<T>(arr: T[], count: number, rng: SeededRandom): T[] {
  if (arr.length === 0) {
    throw new Error('Cannot select from empty array');
  }
  if (count < 0) {
    throw new Error('Count must be non-negative');
  }
  if (count > arr.length) {
    throw new Error('Count cannot exceed array length');
  }

  const result: T[] = [];
  const selectedIndices = new Set<number>();

  while (result.length < count) {
    const index = rng.nextInt(0, arr.length);
    if (!selectedIndices.has(index)) {
      selectedIndices.add(index);
      result.push(arr[index]);
    }
  }

  return result;
}

/**
 * Parse timeBucket parameter to extract year-month key
 * Handles both formats:
 * - ISO timestamp: "2024-12-01T00:00:00.000Z" -> "2024-12-01"
 * - Simple format: "2024-12-01" -> "2024-12-01"
 */
export function parseTimeBucketKey(timeBucket: string): string {
  if (!timeBucket) {
    throw new Error('timeBucket parameter cannot be empty');
  }

  const dt = DateTime.fromISO(timeBucket, { zone: 'utc' });

  if (!dt.isValid) {
    // Fallback to regex if not a valid ISO string
    const match = timeBucket.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : timeBucket;
  }

  // Format as YYYY-MM-01 (first day of month)
  return `${dt.year}-${String(dt.month).padStart(2, '0')}-01`;
}
