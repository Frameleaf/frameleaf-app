import { serverTestConfig } from './vitest.server-config';

export default await serverTestConfig('e2e:maintenance', 'src/specs/maintenance/server/**/*.e2e-spec.ts');
