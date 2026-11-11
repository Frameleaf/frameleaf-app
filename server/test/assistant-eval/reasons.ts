import type { AssistantReasonItem } from 'src/dtos/assistant.dto.js';
import type { Reason } from 'test/assistant-eval/score.js';

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

const visibleClaim = (
  field: NonNullable<Reason>['field'],
  value: string | undefined,
  text: string,
  expected: string,
): Reason => (value && text === expected ? { field, value } : null);

/** Require both the displayed sentence and the structured value to describe the same fixture claim. */
export function claimFromAssistantReason({ kind, text, value }: AssistantReasonItem): Reason {
  switch (kind) {
    case 'person': {
      return visibleClaim('people', value, text, `${value} is in this photo`);
    }
    case 'pet': {
      return visibleClaim('pets', value, text, `${value} is in this photo`);
    }
    case 'place': {
      return visibleClaim('city', value, text, `Taken in ${value}`);
    }
    case 'date': {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        return null;
      }
      return visibleClaim('takenDate', value, text, `Taken ${dateFormat.format(date)}`);
    }
    case 'favorite': {
      return value === undefined && text === 'In your favorites' ? { field: 'favorite', value: true } : null;
    }
    case 'type': {
      if (value !== undefined) {
        return null;
      }
      if (text === 'A photo') {
        return { field: 'type', value: 'IMAGE' };
      }
      if (text === 'A video') {
        return { field: 'type', value: 'VIDEO' };
      }
      return null;
    }
    case 'text': {
      return visibleClaim('ocr', value, text, `Text in the photo matches “${value}”`);
    }
    case 'speech': {
      return visibleClaim('spoken', value, text, `Says “${value}”`);
    }
    case 'description': {
      return visibleClaim('description', value, text, `Description mentions “${value}”`);
    }
    case 'file': {
      return visibleClaim('filename', value, text, `File name contains “${value}”`);
    }
    default: {
      return null;
    }
  }
}
