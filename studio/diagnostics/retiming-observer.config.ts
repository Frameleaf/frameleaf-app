import { fileURLToPath } from 'node:url'
import base from '../engine/vite.config'

// Diagnostic configuration only: preserve the genuine engine setup and tests.
export default {
  ...base,
  test: {
    ...base.test,
    setupFiles: [
      ...(base.test?.setupFiles ?? []),
      fileURLToPath(new URL('./retiming-observer.setup.ts', import.meta.url)),
    ],
  },
}
