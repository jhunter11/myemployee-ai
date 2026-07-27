import { createProviderCatalog } from './factory';
import type { ModelTierRoute } from './contracts';

/**
 * `npm run models:status` — resolves the provider catalog against the real
 * credentials/runtimes on this host and prints, secret-free, which providers are
 * available and how each logical route binds (including graceful degradation to
 * Ollama or a deterministic fallback). Read-only: it probes, it never executes a
 * model. Never prints any token bytes.
 */
async function main(): Promise<void> {
  const catalog = createProviderCatalog();
  const resolution = await catalog.resolve();

  process.stdout.write('Provider availability\n');
  for (const entry of resolution.availability) {
    const mark = entry.available ? 'up  ' : 'down';
    process.stdout.write(`  [${mark}] ${entry.provider.padEnd(8)} ${entry.detail}\n`);
  }

  process.stdout.write('\nRoute bindings (logical tier -> provider)\n');
  const routes: ModelTierRoute[] = ['local', 'economy', 'frontier'];
  for (const route of routes) {
    const binding = resolution.bindings[route];
    const target =
      binding.provider === null
        ? 'deterministic fallback (runtime_not_configured)'
        : `${binding.provider} :: ${binding.model ?? '?'}`;
    process.stdout.write(`  ${route.padEnd(9)} -> ${target}  [${binding.reason}]\n`);
  }

  const anyModel = routes.some((route) => resolution.bindings[route].provider !== null);
  if (!anyModel) {
    process.stdout.write(
      '\nNo model runtime is available. Model turns will fall back to deterministic behaviour.\n'
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `models:status failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
  );
  process.exitCode = 1;
});
