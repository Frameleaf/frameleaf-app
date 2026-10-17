import test from 'node:test';
import { runModelTransportAdmission } from './model-transport-byte-admission.browser.mjs';

test('both Transformers versions and Kokoro browser voice path admit only exact verified bytes', runModelTransportAdmission);
