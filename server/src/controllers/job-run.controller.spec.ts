import { Reflector } from '@nestjs/core';
import { JobController } from 'src/controllers/job.controller.js';
import { JobRunIdParamDto } from 'src/dtos/job-run.dto.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

describe('durable job run route authority', () => {
  it.each(['getJobRuns', 'getJobRunItems'] as const)('requires JobRead and an administrator on %s', (handler) => {
    expect(getAuthenticatedOptions(new Reflector(), JobController.prototype[handler])).toMatchObject({
      permission: Permission.JobRead,
      admin: true,
      public: false,
      sharedLink: false,
    });
  });
  it('validates the inspector run ID before a database read', () => {
    expect(() => JobRunIdParamDto.schema.parse({ id: '../private' })).toThrow();
    expect(() => JobRunIdParamDto.schema.parse({ id: '0195e2a0-0000-7000-8000-000000000001' })).not.toThrow();
  });
});
