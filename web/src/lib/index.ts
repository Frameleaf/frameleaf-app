import { DateTime } from 'luxon';
import { twMerge } from 'tailwind-merge';

export const cleanClass = (...classNames: unknown[]) => {
  const classes: string[] = [];
  flattenClass(classNames, classes);
  return twMerge(classes.join(' '));
};

const flattenClass = (classNames: unknown[], classes: string[]): void => {
  const length = classNames.length;
  for (let index = 0; index < length; index++) {
    // eslint-disable-next-line unicorn/no-computed-property-existence-check -- flatMap visits inherited indices and skips holes.
    if (!(index in classNames)) {
      continue;
    }
    const className = classNames[index];
    if (Array.isArray(className)) {
      flattenClass(className, classes);
    } else if (typeof className === 'string' && className) {
      classes.push(className);
    }
  }
};

export const isDefined = <T>(value: T): value is NonNullable<T> => value !== null && value !== undefined;

export const getHeatmapRange = () => {
  const to = DateTime.utc().startOf('day');
  const from = to.minus({ weeks: 51 }).plus({ days: 1 });
  const fromSunday = from.minus({ days: from.weekday % 7 });
  return { $from: fromSunday.toISODate()!, to: to.toISODate()! };
};
