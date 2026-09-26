import { describe, expect, it } from 'vitest';
import z from 'zod';
import { IsNotSiblingOf, toEmail } from 'src/validation.js';

describe('Validation', () => {
  describe('IsNotSiblingOf', () => {
    const MySchemaBase = z.object({
      attribute1: z.string().optional(),
      attribute2: z.string().optional(),
      attribute3: z.string().optional(),
      unrelatedAttribute: z.string().optional(),
    });

    const MySchema = MySchemaBase.pipe(IsNotSiblingOf(MySchemaBase, 'attribute1', ['attribute2']))
      .pipe(IsNotSiblingOf(MySchemaBase, 'attribute2', ['attribute1', 'attribute3']))
      .pipe(IsNotSiblingOf(MySchemaBase, 'attribute3', ['attribute2']));

    it('passes when only one attribute is present', () => {
      const result = MySchema.safeParse({
        attribute1: 'value1',
        unrelatedAttribute: 'value2',
      });
      expect(result.success).toBe(true);
    });

    it('fails when colliding attributes are present', () => {
      const result = MySchema.safeParse({
        attribute1: 'value1',
        attribute2: 'value2',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('attribute1 cannot exist alongside attribute2');
      }
    });

    it('passes when no colliding attributes are present', () => {
      const result = MySchema.safeParse({
        attribute1: 'value1',
        attribute3: 'value2',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('toEmail', () => {
    it.each([
      'test@example.com',
      'test@immich',
      'first.last+tag@example.com',
      // unicode local parts and internationalized domain names
      'tëst@example.com',
      'leoñ@example.com',
      'test@яндекс.рф',
      'test@xn--d1acpjx3f.xn--p1ai',
      '用户@例子.广告',
      'test@ท่องเที่ยว.ไทย',
    ])('should accept %s', (email) => {
      expect(toEmail.safeParse(email).success).toBe(true);
    });

    it.each(['immich', 'test@@example.com', 'test user@example.com', 'test@example..com', 'test@-example.com'])(
      'should reject %s',
      (email) => {
        expect(toEmail.safeParse(email).success).toBe(false);
      },
    );

    it('should convert the email to lower case', () => {
      expect(toEmail.parse('tÉst@Example.Com')).toBe('tést@example.com');
    });
  });
});
