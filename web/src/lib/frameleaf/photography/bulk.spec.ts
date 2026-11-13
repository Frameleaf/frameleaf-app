import { describe, expect, it } from 'vitest';
import { parseBulkClients } from './bulk';

describe('bulk client paste', () => {
  it('handles quoted names and identifies invalid lines without dropping their row numbers', () => {
    expect(parseBulkClients('"Ellis, Morgan", "morgan@example.test"\r\n\r\nTaylor, invalid')).toEqual([
      { index: 0, clientName: 'Ellis, Morgan', clientEmail: 'morgan@example.test', valid: true },
      { index: 1, clientName: 'Taylor', clientEmail: 'invalid', valid: false },
    ]);
  });
});
