import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { UpgradeCheckController } from 'src/controllers/upgrade-check.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

describe(UpgradeCheckController.name, () => {
  it('is for administrators only', () => {
    expect(getAuthenticatedOptions(new Reflector(), UpgradeCheckController.prototype.getUpgradeCheck)).toMatchObject({
      permission: Permission.ServerStatistics,
      admin: true,
      public: false,
      sharedLink: false,
    });
  });
});
