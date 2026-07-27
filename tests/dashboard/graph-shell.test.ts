import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..', '..');
const index = readFileSync(join(projectRoot, 'public', 'dashboard', 'index.html'), 'utf8');
const app = readFileSync(join(projectRoot, 'public', 'dashboard', 'assets', 'app.js'), 'utf8');
const styles = readFileSync(
  join(projectRoot, 'public', 'dashboard', 'assets', 'styles.css'),
  'utf8'
);

describe('interactive knowledge graph shell', () => {
  it('loads the local graph renderer before the app and exposes native source controls', () => {
    const graphAsset = index.indexOf('/dashboard/assets/graph-view.js');
    const appAsset = index.indexOf('/dashboard/assets/app.js');

    expect(graphAsset).toBeGreaterThan(0);
    expect(graphAsset).toBeLessThan(appAsset);
    expect(index).toMatch(/role="group"\s+aria-label="Graph source"/u);
    expect(index).toContain('id="graph-source-memory"');
    expect(index).toContain('id="graph-source-code"');
    expect(index).toContain('Code · Graphify');
  });

  it('keeps the canvas decorative while exposing labeled controls and native inspectors', () => {
    expect(index).toMatch(
      /<canvas[^>]+class="graph-canvas"[^>]+id="graph-canvas"[^>]+aria-hidden="true"/su
    );
    for (const id of [
      'graph-zoom-in',
      'graph-zoom-out',
      'graph-fit',
      'graph-nodes',
      'graph-neighbors',
      'graph-results-summary',
      'graph-source-status'
    ]) {
      expect(index).toContain(`id="${id}"`);
    }
    expect(index.match(/role="status"/gu)).toHaveLength(1);
  });

  it('keeps Graphify lazy and isolated from the Markdown graph/widget state', () => {
    expect(app).toContain("codeGraph: '/code-graph'");
    expect(app).toContain('state.codeGraph');
    expect(app).toContain("load({ sources: ['codeGraph'] })");
    expect(app).toContain('window.JarvisGraphView');
    expect(app).not.toContain('project_path');
  });

  it('clears the prior canvas when the selected graph source is unavailable', () => {
    expect(app).toContain('function clearRenderedGraph(mode)');
    expect(app).toMatch(/if \(!graph\) \{\s*clearRenderedGraph\(mode\);/u);
    expect(app).toContain('renderedGraphInput = null;');
  });

  it('lets the active graph renderer own shared failure UI', () => {
    expect(app).not.toMatch(/graph:\s*\[\s*'#memory-stats'/u);
    expect(app).toContain('const source = graphSourceName();');
  });

  it('restores native focus after selecting a result or relationship', () => {
    expect(app).toContain('function restoreGraphFocus(nodeId, focusScope)');
    expect(app).toContain("selectGraphNode(node.id, true, 'results')");
    expect(app).toContain("selectGraphNode(neighbor.id, true, 'inspector')");
  });

  it('contains touch gestures within a bounded responsive stage', () => {
    expect(styles).toMatch(/\.graph-canvas\s*\{[^}]*touch-action:\s*none/su);
    expect(styles).toMatch(/\.graph-stage\s*\{[^}]*min-height:/su);
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*\.graph-stage\s*\{/u);
  });
});
