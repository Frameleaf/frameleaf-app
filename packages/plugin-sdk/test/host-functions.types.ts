import { hostFunctions } from '../src/host-functions.js';

const response = hostFunctions('test-token').httpRequest(
  'https://example.test',
);
const ok: boolean = response.ok;
// @ts-expect-error HTTP ok is the host's boolean status, not text.
const text: string = response.ok;
void ok;
void text;
