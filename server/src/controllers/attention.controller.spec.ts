import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AttentionController } from 'src/controllers/attention.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

describe(AttentionController.name, () => {
  it('is for administrators only', () => {
    expect(getAuthenticatedOptions(new Reflector(), AttentionController.prototype.getAttention)).toMatchObject({
      permission: Permission.ServerStatistics,
      admin: true,
      public: false,
      sharedLink: false,
    });
  });
});
