import { IntegrityDeleteReportDto } from 'src/dtos/integrity.dto.js';
import { IntegrityReport } from 'src/enum.js';

it.each(Object.values(IntegrityReport))('accepts the integrity report type %s', (type) => {
  expect(IntegrityDeleteReportDto.schema.parse({ type })).toEqual({ type });
});

it.each([undefined, null, 'unknown', 1])('rejects the invalid integrity report type %s', (type) => {
  expect(IntegrityDeleteReportDto.schema.safeParse({ type }).success).toBe(false);
});
