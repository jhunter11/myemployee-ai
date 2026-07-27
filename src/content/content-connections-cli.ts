import process from 'node:process';

import { createContentProviderCatalog } from './providers/content-provider-catalog';
import type {
  ContentLaneResolution,
  ContentProviderResolution
} from './providers/content-provider-catalog';

/**
 * `npm run content:connections` — resolves the content-provider connections on
 * this host and prints, secret-free, which are live and how each lane binds.
 * Read-only: it probes credentials/runtimes, never synthesizes or fetches media,
 * and never emits an API key.
 */
export interface ContentConnectionsCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

const DEFAULT_IO: ContentConnectionsCliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`)
};

function renderLane(
  title: string,
  lane: ContentLaneResolution<string>,
  io: ContentConnectionsCliIo
): void {
  io.stdout(`\n${title}`);
  for (const entry of lane.availability) {
    const mark = entry.available ? 'up  ' : 'down';
    const tag = entry.premium ? 'premium' : 'free   ';
    io.stdout(`  [${mark}] ${entry.provider.padEnd(18)} ${tag}  ${entry.detail}`);
  }
  io.stdout(`  starter -> ${lane.starter ?? 'none available'}`);
  io.stdout(
    `  premium ready -> ${lane.premiumReady.length > 0 ? lane.premiumReady.join(', ') : 'none connected'}`
  );
}

export function renderResolution(
  resolution: ContentProviderResolution,
  io: ContentConnectionsCliIo
): void {
  io.stdout('Content provider connections');
  renderLane('Narration (voice)', resolution.voice, io);
  renderLane('Visuals', resolution.visual, io);
}

export async function runContentConnectionsCli(
  io: ContentConnectionsCliIo = DEFAULT_IO
): Promise<number> {
  try {
    const resolution = await createContentProviderCatalog().resolve();
    renderResolution(resolution, io);
    return 0;
  } catch {
    io.stderr(JSON.stringify({ error: { code: 'CONTENT_CONNECTIONS_FAILED' } }));
    return 1;
  }
}

if (require.main === module) {
  void runContentConnectionsCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
