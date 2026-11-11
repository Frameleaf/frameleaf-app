import { expect, it } from 'vitest';
import { claimFromAssistantReason } from 'test/assistant-eval/reasons.js';

it.each([
  [
    { kind: 'person', text: 'Maya is in this photo', value: 'Maya' },
    { field: 'people', value: 'Maya' },
  ],
  [
    { kind: 'pet', text: 'Rex is in this photo', value: 'Rex' },
    { field: 'pets', value: 'Rex' },
  ],
  [
    { kind: 'place', text: 'Taken in Banff', value: 'Banff' },
    { field: 'city', value: 'Banff' },
  ],
  [
    { kind: 'date', text: 'Taken Apr 2, 2024', value: '2024-04-02' },
    { field: 'takenDate', value: '2024-04-02' },
  ],
  [
    { kind: 'favorite', text: 'In your favorites' },
    { field: 'favorite', value: true },
  ],
  [
    { kind: 'type', text: 'A photo' },
    { field: 'type', value: 'IMAGE' },
  ],
  [
    { kind: 'type', text: 'A video' },
    { field: 'type', value: 'VIDEO' },
  ],
  [
    { kind: 'text', text: 'Text in the photo matches “Table twelve”', value: 'Table twelve' },
    { field: 'ocr', value: 'Table twelve' },
  ],
  [
    { kind: 'speech', text: 'Says “Save me a seat”', value: 'Save me a seat' },
    { field: 'spoken', value: 'Save me a seat' },
  ],
  [
    { kind: 'description', text: 'Description mentions “a rainy window”', value: 'a rainy window' },
    { field: 'description', value: 'a rainy window' },
  ],
  [
    { kind: 'file', text: 'File name contains “Screenshot”', value: 'Screenshot' },
    { field: 'filename', value: 'Screenshot' },
  ],
] as const)('extracts the claim supported by the visible reason %j', (item, expected) => {
  expect(claimFromAssistantReason(item)).toEqual(expected);
});

it.each([
  { kind: 'person', text: 'Sam is in this photo', value: 'Maya' },
  { kind: 'date', text: 'Taken Apr 3, 2024', value: '2024-04-02' },
  { kind: 'date', text: 'Taken Mar 2, 2024', value: '2024-02-31' },
  { kind: 'text', text: 'Text in the photo matches "Table twelve"', value: 'Table twelve' },
  { kind: 'speech', text: 'Says “Save me a seat!”', value: 'Save me a seat' },
  { kind: 'favorite', text: 'In your favorites', value: 'false' },
  { kind: 'type', text: 'A photo', value: 'VIDEO' },
  { kind: 'visual', text: 'Looks like “a rainy window”', value: 'a rainy window' },
])('rejects an inconsistent or unsupported $kind reason', (item) => {
  expect(claimFromAssistantReason(item)).toBeNull();
});
