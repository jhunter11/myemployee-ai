import { join, resolve } from 'node:path';
import process from 'node:process';

import { MarkdownGraph, type GraphIndex } from './markdown-graph';

export interface RunGraphCliOptions {
  graphRoot: string;
  now?: () => string;
  write?: (message: string) => void;
}

export async function runGraphCli(options: RunGraphCliOptions): Promise<GraphIndex> {
  const graph = new MarkdownGraph({ graphRoot: options.graphRoot, now: options.now });
  await graph.initialize();
  const index = await graph.rebuild();
  const write = options.write ?? console.log;
  write(
    JSON.stringify({
      event: 'memory_graph_rebuilt',
      graphRoot: options.graphRoot,
      nodes: index.nodes.length,
      edges: index.edges.length
    })
  );
  return index;
}

async function runMain(): Promise<void> {
  const projectRoot = resolve(process.env.JARVIS_ROOT ?? process.cwd());
  await runGraphCli({
    graphRoot: resolve(process.env.JARVIS_GRAPH_ROOT ?? join(projectRoot, 'memory', 'graph'))
  });
}

if (require.main === module) {
  void runMain().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
