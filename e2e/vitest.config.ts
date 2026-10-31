import { serverTestConfig } from './vitest.server-config';

export default await serverTestConfig('e2e:server', 'src/specs/server/**/*.e2e-spec.ts');
