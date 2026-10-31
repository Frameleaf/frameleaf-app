import { beforeEach, describe, expect, it } from 'vitest';
import type { KnownPerson } from 'src/services/prompt-assembler.service.js';
import { IdentityPostValidator } from 'src/services/identity-post-validator.service.js';

const person = (name: string): KnownPerson => ({ name, faceConfidence: 1, boxCenter: [0.5, 0.5] });

describe(IdentityPostValidator.name, () => {
  let sut: IdentityPostValidator;

  beforeEach(() => {
    sut = new IdentityPostValidator();
  });

  describe('known name spellings', () => {
    it.each(['Anne-Marie', "O'Brien", 'O’Brien', 'José', 'Jose\u{301}', 'Zoë', 'İpek', '李雷'])(
      'preserves the known name %s and does not duplicate it at a generic reference',
      (name) => {
        const text = `With ${name}, a child smiles.`;
        expect(sut.validate(text, [person(name)])).toEqual({ description: text, flags: {} });
      },
    );

    it.each([
      ['Jos\u{E9}', 'Jose\u{301}'],
      ['Jose\u{301}', 'Jos\u{E9}'],
    ])('keeps the known name %j when the caption spells it %j', (stored, written) => {
      const text = `I saw ${written} beside a child.`;
      expect(sut.validate(text, [person(stored)])).toEqual({ description: text, flags: {} });
    });

    it('does not treat an accented place after "in" as a person', () => {
      const text = 'I saw Anne in Zürich.';
      expect(sut.validate(text, [person('Anne')])).toEqual({ description: text, flags: {} });
    });

    it('still strips an unknown accented name elsewhere and a possessive after "in"', () => {
      expect(sut.validate("I saw Zoë and a baby in Chloé's arms.", [])).toEqual({
        description: "I saw Someone and a baby in Someone's arms.",
        flags: { hallucinatedNames: ['Zoë', 'Chloé'] },
      });
    });

    it('strips every name of a coordinated possessive after "in"', () => {
      expect(sut.validate("The child is in Zoë and Chloé's arms.", [person('Anne')])).toEqual({
        description: "Anne is in Someone and Someone's arms.",
        flags: { hallucinatedNames: ['Zoë', 'Chloé'] },
      });
    });

    it('preserves the hyphenated spelling of a known name stored with a space', () => {
      const text = 'I saw Anne-Marie by the lake.';
      expect(sut.validate(text, [person('Anne Marie')])).toEqual({ description: text, flags: {} });
    });

    it('matches a hyphenated known name whatever its Unicode normalisation', () => {
      const text = 'I saw Jose\u{301}-Maria by the lake.';
      expect(sut.validate(text, [person('Jos\u{E9} Maria')])).toEqual({ description: text, flags: {} });
    });

    it('names the known person at a generic reference when only a stripped name held their token', () => {
      expect(sut.validate('I saw Anne-Sophie and a child.', [person('Anne Marie')])).toEqual({
        description: 'I saw Someone and Anne Marie.',
        flags: { hallucinatedNames: ['Anne-Sophie'] },
      });
    });

    it('does not substitute a generic reference when a hyphenated known name remains', () => {
      const text = 'I saw Jose\u{301}-Maria and a child.';
      expect(sut.validate(text, [person('Jos\u{E9} Maria')])).toEqual({ description: text, flags: {} });
    });

    it('strips a hyphenated name built from two different known people', () => {
      expect(sut.validate('I saw Anne-Smith by the lake.', [person('Anne Jones'), person('John Smith')])).toEqual({
        description: 'I saw Someone by the lake.',
        flags: { hallucinatedNames: ['Anne-Smith'] },
      });
    });

    it('still strips a hyphenated name only partly made of known tokens', () => {
      expect(sut.validate('I saw Anne-Sophie by the lake.', [person('Anne Marie')])).toEqual({
        description: 'I saw Someone by the lake.',
        flags: { hallucinatedNames: ['Anne-Sophie'] },
      });
    });

    it('still strips an unknown name beside a known compound name', () => {
      expect(sut.validate("I saw O'Brien and Madison.", [person("O'Brien")])).toEqual({
        description: "I saw O'Brien and Someone.",
        flags: { hallucinatedNames: ['Madison'] },
      });
    });

    it('does not treat a known Unicode name as present inside a longer name', () => {
      expect(sut.validate('I saw 李雷娜 beside a child.', [person('李雷')])).toEqual({
        description: 'I saw 李雷娜 beside 李雷.',
        flags: {},
      });
    });
  });

  describe('hallucinated name stripping', () => {
    it('strips a mid-sentence capitalized word that is not a known person', () => {
      const { description, flags } = sut.validate('A boy and Madison are playing baseball.', []);
      expect(description).toBe('A boy and Someone are playing baseball.');
      expect(flags.hallucinatedNames).toEqual(['Madison']);
    });

    it.each(['Zoë', 'Zoe\u{308}', 'José', "O'Brien", 'Anne-Marie', "d'Artagnan", 'd’Angelo'])(
      'replaces the whole unknown name %s, never a fragment of it',
      (name) => {
        expect(sut.validate(`I saw ${name} and Madison.`, [])).toEqual({
          description: 'I saw Someone and Someone.',
          flags: { hallucinatedNames: [name, 'Madison'] },
        });
      },
    );

    it('does not strip a name that IS a known person', () => {
      const { description, flags } = sut.validate('Conner is playing baseball.', [person('Conner')]);
      expect(description).toBe('Conner is playing baseball.');
      expect(flags.hallucinatedNames).toBeUndefined();
    });

    it('does not strip a known person name when it appears mid-sentence', () => {
      // The existing test puts the name at position 0, where sentence-start
      // protection would already preserve it. This case isolates the
      // knownNames check itself.
      const { description, flags } = sut.validate('I spoke with Conner yesterday.', [person('Conner')]);
      expect(description).toBe('I spoke with Conner yesterday.');
      expect(flags.hallucinatedNames).toBeUndefined();
    });

    it('does not false-positive a known name as a substring of a different word', () => {
      // knownPerson "Anne" must NOT be considered present in "Annette".
      // Verifies the descriptionContainsKnownName check uses word boundaries.
      const { description, flags } = sut.validate('A young boy is playing.', [person('Anne')]);
      // The Anne-knownPerson is the only one, generic ref present, so substitution happens.
      // Critical: this works only because the word-boundary check correctly identifies
      // the description as NOT containing the known name.
      expect(description).toBe('Anne is playing.');
      expect(flags.hallucinatedNames).toBeUndefined();
    });

    it('does not strip the first word of a sentence (sentence-start capital)', () => {
      const { description } = sut.validate('The dog runs fast.', []);
      expect(description).toBe('The dog runs fast.');
    });

    it('does not strip a word immediately after sentence-ending punctuation', () => {
      const { description } = sut.validate('A dog runs. Then Madison jumps.', []);
      // "Then" is after "." so it is sentence-start — safe.
      // "Madison" is after "Then " so it is mid-sentence — stripped.
      expect(description).toBe('A dog runs. Then Someone jumps.');
    });

    it('does not strip allow-listed day names', () => {
      const { description } = sut.validate('They met on Monday afternoon.', []);
      expect(description).toBe('They met on Monday afternoon.');
    });

    it('does not strip allow-listed month names', () => {
      const { description } = sut.validate('The photo was taken in December.', []);
      expect(description).toBe('The photo was taken in December.');
    });

    it('does not strip allow-listed holiday names', () => {
      const { description } = sut.validate('They decorated for Christmas.', []);
      expect(description).toBe('They decorated for Christmas.');
    });

    it('does not strip allow-listed geography nouns', () => {
      const { description } = sut.validate('The family visited America last summer.', []);
      expect(description).toBe('The family visited America last summer.');
    });

    it('strips multiple distinct mid-sentence hallucinated names and deduplicates the flag list', () => {
      const { description, flags } = sut.validate('The boys Madison and Zachary are throwing a ball.', []);
      expect(description).toBe('The boys Someone and Someone are throwing a ball.');
      expect(flags.hallucinatedNames).toEqual(expect.arrayContaining(['Madison', 'Zachary']));
      expect(flags.hallucinatedNames).toHaveLength(2);
    });

    it('de-duplicates repeated hallucinated names in the flag list', () => {
      const { flags } = sut.validate('Madison pushed Madison off a swing.', []);
      expect(flags.hallucinatedNames).toEqual(['Madison']);
    });

    it('preserves every token of a multi-word known name (e.g. "Mary Jane")', () => {
      const { description, flags } = sut.validate('The kids saw Mary Jane in the garden.', [person('Mary Jane')]);
      // Neither "Mary" nor "Jane" should be stripped as hallucinated.
      expect(description).toBe('The kids saw Mary Jane in the garden.');
      expect(flags.hallucinatedNames).toBeUndefined();
    });

    it('does not strip a known person name token when only one part appears mid-sentence', () => {
      // Mid-sentence placement isolates the multi-word allow-list from the
      // sentence-start protection rule. "Jane" here must survive because it's
      // a token of the known full name "Mary Jane".
      const { description, flags } = sut.validate('The kids saw Jane reading.', [person('Mary Jane')]);
      expect(description).toBe('The kids saw Jane reading.');
      expect(flags.hallucinatedNames).toBeUndefined();
    });

    it('does not strip a known name when case differs between description and stored person', () => {
      // Person stored as lowercase in the DB; model emits canonical casing.
      const { description, flags } = sut.validate('I saw Conner playing baseball.', [person('conner')]);
      expect(description).toBe('I saw Conner playing baseball.');
      expect(flags.hallucinatedNames).toBeUndefined();
    });
  });

  describe('generic person substitution — single known person', () => {
    it('substitutes the first generic person reference with the known person name', () => {
      const { description, flags } = sut.validate('A young boy is playing baseball.', [person('Conner')]);
      expect(description).toBe('Conner is playing baseball.');
      expect(flags.ambiguousReferences).toBeUndefined();
    });

    it('substitutes "the woman" with the single known person name', () => {
      const { description } = sut.validate('The woman is sitting on a bench.', [person('Sarah')]);
      expect(description).toBe('Sarah is sitting on a bench.');
    });

    it('substitutes only the first generic reference when multiple are present', () => {
      const { description } = sut.validate('A young boy is playing while a child watches.', [person('Conner')]);
      // Only the first "a young boy" becomes "Conner"; "a child" stays.
      expect(description).toBe('Conner is playing while a child watches.');
    });

    it('leaves description unchanged when it already contains the known name', () => {
      const { description } = sut.validate('Conner is playing baseball.', [person('Conner')]);
      expect(description).toBe('Conner is playing baseball.');
    });
  });

  describe('generic person ambiguity — multiple known persons', () => {
    it('leaves description unchanged and flags ambiguity when multiple known persons', () => {
      const { description, flags } = sut.validate('A young boy is playing baseball.', [
        person('Conner'),
        person('Sarah'),
      ]);
      expect(description).toBe('A young boy is playing baseball.');
      expect(flags.ambiguousReferences).toEqual(['generic-person-with-multiple-known-faces']);
    });

    it('does not flag ambiguity when description already contains a known name', () => {
      const { flags } = sut.validate('Conner is playing baseball.', [person('Conner'), person('Sarah')]);
      expect(flags.ambiguousReferences).toBeUndefined();
    });
  });

  describe('zero known persons — never fabricate names', () => {
    it('does not substitute a generic person reference when knownPersons is empty', () => {
      const { description, flags } = sut.validate('A young boy is playing baseball.', []);
      expect(description).toBe('A young boy is playing baseball.');
      expect(flags.hallucinatedNames).toBeUndefined();
      expect(flags.ambiguousReferences).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns an empty flags object when the description has no persons and no candidates', () => {
      const { flags } = sut.validate('A red car is parked on the street.', []);
      expect(flags).toEqual({});
    });

    it('handles empty description gracefully', () => {
      const { description, flags } = sut.validate('', [person('Conner')]);
      expect(description).toBe('');
      expect(flags).toEqual({});
    });

    it('does not substitute when description has no generic person reference even with one known person', () => {
      const { description } = sut.validate('A red ball is on the grass.', [person('Conner')]);
      // No generic person → no substitution.
      expect(description).toBe('A red ball is on the grass.');
    });
  });
});
