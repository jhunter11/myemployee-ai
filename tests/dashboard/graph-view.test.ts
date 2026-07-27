import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface GraphViewModule {
  createRenderer(options: { canvas: unknown }): {
    destroy(): void;
    getGraph(): ReturnType<GraphViewModule['normalizeGraph']>;
    getViewport(): { x: number; y: number; scale: number };
    panBy(x: number, y: number): { x: number; y: number; scale: number };
    setGraph(input: unknown): ReturnType<GraphViewModule['normalizeGraph']>;
  };
  normalizeGraph(input: unknown): {
    source: 'memory' | 'graphify';
    nodes: Array<{
      id: string;
      title: string;
      type: string;
      path: string;
      group: string;
      x: number;
      y: number;
    }>;
    edges: Array<{ from: string; to: string; relation: string }>;
  };
  reconcileSelection(graph: unknown, selectedId: unknown): string | null;
  neighbors(
    graph: unknown,
    selectedId: unknown
  ): Array<{
    id: string;
    inbound: string[];
    outbound: string[];
  }>;
  search(
    graph: unknown,
    query: unknown,
    limit?: unknown
  ): {
    total: number;
    items: Array<{ id: string }>;
  };
  zoomAt(
    viewport: { x: number; y: number; scale: number },
    screenPoint: { x: number; y: number },
    factor: number
  ): { x: number; y: number; scale: number };
  hitTest(
    graph: unknown,
    viewport: { x: number; y: number; scale: number },
    screenPoint: { x: number; y: number },
    radius?: number
  ): string | null;
}

const requireAsset = createRequire(__filename);
const graphView = requireAsset(
  join(__dirname, '..', '..', 'public', 'dashboard', 'assets', 'graph-view.js')
) as GraphViewModule;

const memoryGraph = {
  generatedAt: '2026-07-25T12:00:00.000Z',
  nodes: [
    { id: 'index', type: 'index', title: 'Memory', path: 'index.md' },
    { id: 'agency', type: 'agency', title: 'Agency', path: 'agency/index.md' },
    { id: 'orphan', type: 'note', title: 'Orphan', path: 'orphan.md' }
  ],
  edges: [
    { from: 'index', to: 'agency' },
    { from: 'agency', to: 'index' }
  ]
};

const codeGraph = {
  schemaVersion: 1,
  source: 'graphify',
  scope: 'harness',
  indexedAt: '2026-07-25T12:00:00.000Z',
  builtAtCommit: 'a'.repeat(40),
  currentCommit: 'b'.repeat(40),
  revisionStatus: 'stale',
  totalNodeCount: 3,
  totalEdgeCount: 2,
  omittedNonStructuralEdgeCount: 0,
  nodes: [
    {
      id: 'alpha',
      title: 'Alpha',
      type: 'code',
      path: 'src/alpha.ts',
      line: 1,
      community: 1
    },
    {
      id: 'beta',
      title: 'Beta',
      type: 'code',
      path: 'src/beta.ts',
      line: 8,
      community: 1
    },
    {
      id: 'gamma',
      title: 'Gamma',
      type: 'code',
      path: 'src/gamma.ts',
      line: 3,
      community: 2
    }
  ],
  edges: [
    { from: 'alpha', to: 'beta', relation: 'calls' },
    { from: 'beta', to: 'gamma', relation: 'references' }
  ]
};

function fakeCanvas() {
  const context = {
    arc() {},
    beginPath() {},
    clearRect() {},
    closePath() {},
    fill() {},
    fillText() {},
    lineTo() {},
    moveTo() {},
    setTransform() {},
    stroke() {}
  };
  return {
    addEventListener() {},
    clientHeight: 400,
    clientWidth: 600,
    getBoundingClientRect: () => ({ height: 400, left: 0, top: 0, width: 600 }),
    getContext: () => context,
    height: 400,
    removeEventListener() {},
    setAttribute() {},
    style: {},
    width: 600
  };
}

describe('interactive graph view model', () => {
  it('normalizes Memory and Graphify independently with deterministic finite positions', () => {
    const memory = graphView.normalizeGraph(memoryGraph);
    const code = graphView.normalizeGraph(codeGraph);
    const repeated = graphView.normalizeGraph(codeGraph);

    expect(memory.source).toBe('memory');
    expect(code.source).toBe('graphify');
    expect(memory.edges).toEqual([{ from: 'agency', to: 'index', relation: 'links' }]);
    expect(code.edges).toEqual(codeGraph.edges);
    expect(code.nodes.map(({ x, y }) => [x, y])).toEqual(repeated.nodes.map(({ x, y }) => [x, y]));
    expect(code.nodes.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);

    const communityOne = code.nodes.filter(({ group }) => group === 'community:1');
    const communityTwo = code.nodes.filter(({ group }) => group === 'community:2');
    const distance = (left: { x: number; y: number }, right: { x: number; y: number }) =>
      Math.hypot(left.x - right.x, left.y - right.y);
    expect(distance(communityOne[0]!, communityOne[1]!)).toBeLessThan(
      distance(communityOne[0]!, communityTwo[0]!)
    );
  });

  it('deduplicates reciprocal neighbors while retaining direction evidence', () => {
    const graph = graphView.normalizeGraph(memoryGraph);

    expect(graphView.neighbors(graph, 'index')).toEqual([
      {
        id: 'agency',
        inbound: ['links'],
        outbound: ['links']
      }
    ]);
  });

  it('reconciles stale selection and returns bounded stable search results', () => {
    const graph = graphView.normalizeGraph(codeGraph);

    expect(graphView.reconcileSelection(graph, 'removed')).toBe('alpha');
    expect(graphView.reconcileSelection({ nodes: [] }, 'alpha')).toBeNull();
    expect(graphView.search(graph, 'src/', 2)).toEqual({
      total: 3,
      items: [{ id: 'alpha' }, { id: 'beta' }]
    });
    expect(graphView.search(graph, 'references', 10).items.map(({ id }) => id)).toEqual([
      'beta',
      'gamma'
    ]);
  });

  it('clamps cursor-centered zoom and hit-tests in world coordinates', () => {
    const graph = graphView.normalizeGraph(codeGraph);
    const alpha = graph.nodes.find(({ id }) => id === 'alpha')!;
    const viewport = { x: 50, y: 80, scale: 1 };
    const screenPoint = { x: alpha.x + viewport.x, y: alpha.y + viewport.y };

    expect(graphView.hitTest(graph, viewport, screenPoint, 12)).toBe('alpha');
    const zoomed = graphView.zoomAt(viewport, screenPoint, 100);
    expect(zoomed.scale).toBe(4);
    expect((screenPoint.x - zoomed.x) / zoomed.scale).toBeCloseTo(alpha.x);
    expect((screenPoint.y - zoomed.y) / zoomed.scale).toBeCloseTo(alpha.y);
    expect(graphView.zoomAt(viewport, screenPoint, 0.0001).scale).toBe(0.25);
  });

  it('retains viewport and dragged positions across source switches and refreshes', () => {
    const renderer = graphView.createRenderer({ canvas: fakeCanvas() });
    try {
      renderer.setGraph(memoryGraph);
      renderer.panBy(83, -27);
      const exploredViewport = renderer.getViewport();
      const agency = renderer.getGraph().nodes.find(({ id }) => id === 'agency')!;
      agency.x += 37;
      agency.y -= 19;
      const exploredPosition = { x: agency.x, y: agency.y };

      renderer.setGraph(codeGraph);
      renderer.setGraph(memoryGraph);

      expect(renderer.getViewport()).toEqual(exploredViewport);
      expect(renderer.getGraph().nodes.find(({ id }) => id === 'agency')).toMatchObject(
        exploredPosition
      );

      renderer.setGraph(memoryGraph);
      expect(renderer.getViewport()).toEqual(exploredViewport);
      expect(renderer.getGraph().nodes.find(({ id }) => id === 'agency')).toMatchObject(
        exploredPosition
      );
    } finally {
      renderer.destroy();
    }
  });
});
