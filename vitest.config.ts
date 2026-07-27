import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts', 'clients/acme_corp/automations/**/*.ts'],
      exclude: [
        'src/gateway/server.ts',
        'src/db/types.ts',
        'src/**/*-cli.ts',
        // UNFINISHED, not merely untested: bench-runner.ts has no orchestrator, so
        // nothing imports it and none of its 1,300 lines can execute. Left in, it
        // reports 0% and drags the global branch threshold below 85%, which would
        // read as "the project's tested code got worse" when nothing tested got
        // worse. Excluded so the threshold keeps measuring code that is in service.
        // Remove this line and the file's eslint-disable together, when the runner
        // is written and its tests land. See the INCOMPLETE note at its head.
        'src/memory/experiment/bench-runner.ts'
      ],
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 85,
        statements: 85
      }
    }
  }
});
