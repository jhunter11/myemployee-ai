(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisGraphView = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;
  const MAX_SEARCH_RESULTS = 100;
  const MAX_TEXT_LENGTH = 400;
  const GROUP_SPACING = 360;
  const NODE_SPACING = 42;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, scale: 1 });
  const EMPTY_GRAPH = Object.freeze({
    source: 'memory',
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    directionEdges: Object.freeze([]),
    metadata: Object.freeze({})
  });
  const GROUP_COLORS = Object.freeze([
    '#7dd8c7',
    '#91bde8',
    '#e8ba70',
    '#c9a7eb',
    '#ef9ca8',
    '#8fd19e',
    '#d8c77d',
    '#8ecad8',
    '#d69bd2',
    '#aeb9ef'
  ]);

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function finite(value, fallback = 0) {
    return Number.isFinite(value) ? Number(value) : fallback;
  }

  function safeInteger(value, fallback = 0) {
    return Number.isSafeInteger(value) ? value : fallback;
  }

  function boundedText(value, fallback = '', maximum = MAX_TEXT_LENGTH) {
    const candidate =
      typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
    const normalized = candidate
      .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return (normalized || fallback).slice(0, maximum);
  }

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
  }

  function stableHash(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function normalizeRelation(value, fallback) {
    const relation = boundedText(value, fallback, 64)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '_')
      .replace(/^_+|_+$/gu, '');
    return relation || fallback;
  }

  function nodeId(value) {
    return boundedText(value, '', 256);
  }

  function normalizeNode(rawInput, source) {
    const raw = safeObject(rawInput);
    const id = nodeId(raw.id);
    if (!id) return null;
    const title = boundedText(raw.title ?? raw.label, id, 240);
    const type =
      boundedText(
        raw.type ?? raw.kind ?? raw.file_type,
        source === 'graphify' ? 'code' : 'node',
        64
      )
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, '_')
        .replace(/^_+|_+$/gu, '') || (source === 'graphify' ? 'code' : 'node');
    const path = boundedText(raw.path ?? raw.sourceFile ?? raw.source_file, id, 400);
    const community =
      Number.isSafeInteger(raw.community) && raw.community >= 0 ? raw.community : null;
    const group =
      source === 'graphify' && community !== null ? `community:${community}` : `type:${type}`;
    const line = Number.isSafeInteger(raw.line) && raw.line > 0 ? raw.line : null;
    return {
      id,
      title,
      type,
      path,
      group,
      line,
      community,
      x: 0,
      y: 0,
      degree: 0
    };
  }

  function rawEdge(rawInput, source) {
    const raw = safeObject(rawInput);
    const from = nodeId(raw.from ?? raw.source);
    const to = nodeId(raw.to ?? raw.target);
    if (!from || !to) return null;
    return {
      from,
      to,
      relation:
        source === 'memory' ? 'links' : normalizeRelation(raw.relation ?? raw.type, 'relates_to')
    };
  }

  function uniqueDirectedEdges(rawEdges, source, nodeIds) {
    const seen = new Set();
    const edges = [];
    safeArray(rawEdges).forEach((raw) => {
      const edge = rawEdge(raw, source);
      if (!edge || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
      const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(edge);
    });
    return edges.sort(
      (left, right) =>
        compareText(left.from, right.from) ||
        compareText(left.to, right.to) ||
        compareText(left.relation, right.relation)
    );
  }

  function collapseMemoryEdges(directionEdges) {
    const collapsed = new Map();
    directionEdges.forEach((edge) => {
      const from = compareText(edge.from, edge.to) <= 0 ? edge.from : edge.to;
      const to = from === edge.from ? edge.to : edge.from;
      const key = `${from}\u0000${to}`;
      if (!collapsed.has(key)) collapsed.set(key, { from, to, relation: 'links' });
    });
    return [...collapsed.values()].sort(
      (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to)
    );
  }

  /**
   * A deterministic cluster layout. It is deliberately linear in graph size:
   * degree counting touches each edge once, grouping touches each node once, and
   * each group receives one stable grid center. There is no force loop whose
   * cost or final position depends on frame timing.
   */
  function positionNodes(nodes, edges) {
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    edges.forEach((edge) => {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      if (edge.to !== edge.from) degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    });
    nodes.forEach((node) => {
      node.degree = degree.get(node.id) || 0;
    });

    const groups = new Map();
    nodes.forEach((node) => {
      const bucket = groups.get(node.group) || [];
      bucket.push(node);
      groups.set(node.group, bucket);
    });
    const groupIds = [...groups.keys()].sort(compareText);
    const columns = Math.max(1, Math.ceil(Math.sqrt(groupIds.length)));
    const rows = Math.max(1, Math.ceil(groupIds.length / columns));

    groupIds.forEach((groupId, groupIndex) => {
      const column = groupIndex % columns;
      const row = Math.floor(groupIndex / columns);
      const centerX = (column - (columns - 1) / 2) * GROUP_SPACING;
      const centerY = (row - (rows - 1) / 2) * GROUP_SPACING;
      const phase = ((stableHash(groupId) % 360) * Math.PI) / 180;
      const members = groups.get(groupId) || [];
      members.sort((left, right) => right.degree - left.degree || compareText(left.id, right.id));
      members.forEach((node, memberIndex) => {
        if (memberIndex === 0) {
          node.x = centerX;
          node.y = centerY;
          return;
        }
        const radius = NODE_SPACING * Math.sqrt(memberIndex);
        const angle = phase + memberIndex * GOLDEN_ANGLE;
        node.x = centerX + Math.cos(angle) * radius;
        node.y = centerY + Math.sin(angle) * radius;
      });
    });
  }

  function graphMetadata(raw, source, nodeCount, edgeCount) {
    return {
      generatedAt: boundedText(
        source === 'graphify' ? (raw.indexedAt ?? raw.generatedAt) : raw.generatedAt,
        '',
        80
      ),
      builtAtCommit: boundedText(raw.builtAtCommit, '', 64),
      currentCommit: boundedText(raw.currentCommit, '', 64),
      revisionStatus: boundedText(raw.revisionStatus, '', 32),
      scope: boundedText(raw.scope, source === 'graphify' ? 'harness' : 'global', 64),
      totalNodeCount: Math.max(nodeCount, safeInteger(raw.totalNodeCount, nodeCount)),
      totalEdgeCount: Math.max(edgeCount, safeInteger(raw.totalEdgeCount, edgeCount)),
      omittedNonStructuralEdgeCount: Math.max(0, safeInteger(raw.omittedNonStructuralEdgeCount, 0))
    };
  }

  /**
   * Normalizes both dashboard Markdown indexes and the allowlisted Graphify
   * projection into one render model. The caller's objects are never mutated.
   */
  function normalizeGraph(input) {
    const raw = safeObject(input);
    const source = raw.source === 'graphify' ? 'graphify' : 'memory';
    const seenNodeIds = new Set();
    const nodes = safeArray(raw.nodes)
      .map((node) => normalizeNode(node, source))
      .filter((node) => {
        if (node === null || seenNodeIds.has(node.id)) return false;
        seenNodeIds.add(node.id);
        return true;
      })
      .sort((left, right) => compareText(left.id, right.id));

    const suppliedDirections =
      source === 'memory' && Array.isArray(raw.directionEdges) ? raw.directionEdges : raw.edges;
    const directionEdges = uniqueDirectedEdges(suppliedDirections, source, seenNodeIds);
    const edges =
      source === 'memory'
        ? collapseMemoryEdges(directionEdges)
        : uniqueDirectedEdges(raw.edges, source, seenNodeIds);
    positionNodes(nodes, edges);

    const graph = {
      source,
      nodes,
      edges,
      directionEdges: source === 'memory' ? directionEdges : edges,
      metadata: graphMetadata(raw, source, nodes.length, edges.length)
    };
    Object.defineProperty(graph, '__jarvisGraphView', {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false
    });
    return graph;
  }

  function graphModel(input) {
    const graph = safeObject(input);
    return graph.__jarvisGraphView === true ? graph : normalizeGraph(graph);
  }

  function reconcileSelection(graphInput, selectedIdInput) {
    const graph = graphModel(graphInput);
    const selectedId = nodeId(selectedIdInput);
    if (selectedId && graph.nodes.some((node) => node.id === selectedId)) return selectedId;
    return graph.nodes[0]?.id || null;
  }

  function neighbors(graphInput, selectedIdInput) {
    const graph = graphModel(graphInput);
    const selectedId = nodeId(selectedIdInput);
    if (!selectedId || !graph.nodes.some((node) => node.id === selectedId)) return [];
    const records = new Map();
    const directions =
      graph.source === 'memory' ? safeArray(graph.directionEdges) : safeArray(graph.edges);

    directions.forEach((edgeInput) => {
      const edge = safeObject(edgeInput);
      const from = nodeId(edge.from);
      const to = nodeId(edge.to);
      const relation = normalizeRelation(
        edge.relation,
        graph.source === 'memory' ? 'links' : 'relates_to'
      );
      if (from === to) return;
      if (from !== selectedId && to !== selectedId) return;
      const neighborId = from === selectedId ? to : from;
      if (!neighborId) return;
      const record = records.get(neighborId) || {
        id: neighborId,
        inbound: new Set(),
        outbound: new Set()
      };
      if (from === selectedId) record.outbound.add(relation);
      if (to === selectedId) record.inbound.add(relation);
      records.set(neighborId, record);
    });

    return [...records.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map((record) => ({
        id: record.id,
        inbound: [...record.inbound].sort(compareText),
        outbound: [...record.outbound].sort(compareText)
      }));
  }

  function normalizedQuery(value) {
    return boundedText(value, '', 240).toLowerCase();
  }

  function matchingNodeIds(graph, queryInput) {
    const query = normalizedQuery(queryInput);
    if (!query) return new Set(graph.nodes.map((node) => node.id));
    const matches = new Set();
    graph.nodes.forEach((node) => {
      const haystack = [
        node.id,
        node.title,
        node.type,
        node.path,
        node.group,
        node.line === null ? '' : String(node.line)
      ]
        .join('\n')
        .toLowerCase();
      if (haystack.includes(query)) matches.add(node.id);
    });
    graph.edges.forEach((edge) => {
      if (String(edge.relation).toLowerCase().includes(query)) {
        matches.add(edge.from);
        matches.add(edge.to);
      }
    });
    return matches;
  }

  function search(graphInput, queryInput, limitInput = 50) {
    const graph = graphModel(graphInput);
    const matches = matchingNodeIds(graph, queryInput);
    const limit =
      Number.isSafeInteger(limitInput) && limitInput >= 0
        ? Math.min(limitInput, MAX_SEARCH_RESULTS)
        : 50;
    const matchingNodes = graph.nodes.filter((node) => matches.has(node.id));
    return {
      total: matchingNodes.length,
      items: matchingNodes.slice(0, limit).map((node) => ({ id: node.id }))
    };
  }

  function normalizedViewport(viewportInput) {
    const viewport = safeObject(viewportInput);
    return {
      x: finite(viewport.x, DEFAULT_VIEWPORT.x),
      y: finite(viewport.y, DEFAULT_VIEWPORT.y),
      scale: clamp(viewport.scale, MIN_SCALE, MAX_SCALE)
    };
  }

  function normalizedPoint(pointInput) {
    const point = safeObject(pointInput);
    return { x: finite(point.x), y: finite(point.y) };
  }

  function zoomAt(viewportInput, screenPointInput, factorInput) {
    const viewport = normalizedViewport(viewportInput);
    const screenPoint = normalizedPoint(screenPointInput);
    const factor = Number.isFinite(factorInput) && factorInput > 0 ? factorInput : 1;
    const nextScale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE);
    const worldX = (screenPoint.x - viewport.x) / viewport.scale;
    const worldY = (screenPoint.y - viewport.y) / viewport.scale;
    return {
      x: screenPoint.x - worldX * nextScale,
      y: screenPoint.y - worldY * nextScale,
      scale: nextScale
    };
  }

  function hitTest(graphInput, viewportInput, screenPointInput, radiusInput = 12) {
    const graph = graphModel(graphInput);
    const viewport = normalizedViewport(viewportInput);
    const point = normalizedPoint(screenPointInput);
    const radius = Math.max(1, finite(radiusInput, 12)) / viewport.scale;
    const worldX = (point.x - viewport.x) / viewport.scale;
    const worldY = (point.y - viewport.y) / viewport.scale;
    let nearest = null;
    let nearestDistance = radius;

    for (let index = graph.nodes.length - 1; index >= 0; index -= 1) {
      const node = graph.nodes[index];
      const distance = Math.hypot(node.x - worldX, node.y - worldY);
      if (distance <= nearestDistance) {
        nearest = node.id;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function runtimeRoot() {
    return typeof globalThis === 'object' ? globalThis : {};
  }

  function canvasPoint(canvas, eventInput) {
    const event = safeObject(eventInput);
    const rectangle =
      typeof canvas.getBoundingClientRect === 'function'
        ? canvas.getBoundingClientRect()
        : { left: 0, top: 0 };
    const clientX = Number.isFinite(event.clientX) ? event.clientX : finite(event.offsetX);
    const clientY = Number.isFinite(event.clientY) ? event.clientY : finite(event.offsetY);
    return {
      x: clientX - finite(rectangle.left),
      y: clientY - finite(rectangle.top)
    };
  }

  function nodeRadius(node) {
    return Math.min(9, 4.5 + Math.sqrt(Math.max(0, finite(node.degree))) * 0.8);
  }

  function colorForGroup(group) {
    return GROUP_COLORS[stableHash(group) % GROUP_COLORS.length];
  }

  function createRenderer(optionsInput, secondaryOptions) {
    const options =
      optionsInput && typeof optionsInput.getContext === 'function'
        ? { ...safeObject(secondaryOptions), canvas: optionsInput }
        : safeObject(optionsInput);
    const canvas = options.canvas;
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Graph renderer requires a canvas element');
    }
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Graph renderer could not acquire a 2D canvas context');

    const runtime = runtimeRoot();
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    const onViewportChange =
      typeof options.onViewportChange === 'function' ? options.onViewportChange : null;
    const onHover = typeof options.onHover === 'function' ? options.onHover : null;
    const reducedMotion =
      typeof runtime.matchMedia === 'function' &&
      runtime.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let graph = EMPTY_GRAPH;
    let selection = null;
    let hover = null;
    let query = '';
    let viewport = { ...DEFAULT_VIEWPORT };
    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let destroyed = false;
    let scheduledFrame = null;
    let interaction = null;
    let fitWhenVisible = false;
    const viewStates = new Map();

    if (typeof canvas.setAttribute === 'function') canvas.setAttribute('aria-hidden', 'true');
    if (canvas.style) canvas.style.touchAction = 'none';

    function invoke(callback, ...argumentsList) {
      if (!callback) return;
      try {
        callback(...argumentsList);
      } catch (error) {
        if (runtime.console && typeof runtime.console.error === 'function') {
          runtime.console.error('Graph renderer callback failed.', error);
        }
      }
    }

    function requestFrame(callback) {
      return typeof runtime.requestAnimationFrame === 'function'
        ? runtime.requestAnimationFrame(callback)
        : null;
    }

    function cancelFrame(identifier) {
      if (identifier !== null && typeof runtime.cancelAnimationFrame === 'function') {
        runtime.cancelAnimationFrame(identifier);
      }
    }

    function cssColor(name, fallback) {
      try {
        if (typeof runtime.getComputedStyle !== 'function') return fallback;
        return runtime.getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
      } catch (_error) {
        return fallback;
      }
    }

    function measure() {
      const rectangle =
        typeof canvas.getBoundingClientRect === 'function'
          ? canvas.getBoundingClientRect()
          : { width: canvas.clientWidth, height: canvas.clientHeight };
      const measuredWidth = finite(rectangle.width, finite(canvas.clientWidth, width));
      const measuredHeight = finite(rectangle.height, finite(canvas.clientHeight, height));
      width = Math.max(1, measuredWidth);
      height = Math.max(1, measuredHeight);
      pixelRatio = clamp(runtime.devicePixelRatio, 1, 2);
      const backingWidth = Math.max(1, Math.round(width * pixelRatio));
      const backingHeight = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      if (typeof context.setTransform === 'function') {
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      }
      if (fitWhenVisible && measuredWidth > 1 && measuredHeight > 1) fit();
    }

    function worldToScreen(node) {
      return {
        x: node.x * viewport.scale + viewport.x,
        y: node.y * viewport.scale + viewport.y
      };
    }

    function visible(point, margin = 30) {
      return (
        point.x >= -margin &&
        point.x <= width + margin &&
        point.y >= -margin &&
        point.y <= height + margin
      );
    }

    function drawArrow(from, to, color) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 12) return;
      const unitX = dx / distance;
      const unitY = dy / distance;
      const tipX = to.x - unitX * 8;
      const tipY = to.y - unitY * 8;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(tipX - unitX * 7 + unitY * 4, tipY - unitY * 7 - unitX * 4);
      context.lineTo(tipX - unitX * 7 - unitY * 4, tipY - unitY * 7 + unitX * 4);
      context.closePath();
      context.fillStyle = color;
      context.fill();
    }

    function draw() {
      if (destroyed) return;
      scheduledFrame = null;
      if (typeof context.setTransform === 'function') {
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      }
      context.clearRect(0, 0, width, height);
      const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
      const matches = matchingNodeIds(graph, query);
      const hasQuery = normalizedQuery(query).length > 0;
      const selectedNeighborIds = selection
        ? new Set(neighbors(graph, selection).map((neighbor) => neighbor.id))
        : new Set();
      const edgeColor = cssColor('--line-strong', '#596b77');
      const quietColor = cssColor('--quiet', '#a4b1bb');
      const inkColor = cssColor('--ink', '#edf2f5');
      const selectedColor = cssColor('--signal', '#7dd8c7');
      const panelColor = cssColor('--panel', '#111820');

      graph.edges.forEach((edge) => {
        const left = nodeMap.get(edge.from);
        const right = nodeMap.get(edge.to);
        if (!left || !right) return;
        const from = worldToScreen(left);
        const to = worldToScreen(right);
        if (!visible(from, 80) && !visible(to, 80)) return;
        const incident = selection === edge.from || selection === edge.to;
        const queryMatch = matches.has(edge.from) || matches.has(edge.to);
        context.globalAlpha = selection
          ? incident
            ? 0.9
            : 0.1
          : hasQuery
            ? queryMatch
              ? 0.7
              : 0.08
            : 0.32;
        context.strokeStyle = incident ? selectedColor : edgeColor;
        context.lineWidth = incident ? 1.8 : 1;
        context.beginPath();
        if (edge.from === edge.to) {
          context.arc(from.x + 8, from.y - 8, 10, 0, Math.PI * 2);
        } else {
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
        }
        context.stroke();
        if (incident && graph.source === 'graphify' && edge.from !== edge.to) {
          drawArrow(from, to, selectedColor);
        }
      });

      let labelsDrawn = 0;
      const labelBudget = graph.nodes.length <= 40 ? graph.nodes.length : 30;
      graph.nodes.forEach((node) => {
        const point = worldToScreen(node);
        if (!visible(point)) return;
        const selected = selection === node.id;
        const hovered = hover === node.id;
        const matched = matches.has(node.id);
        const radius = Math.max(3, nodeRadius(node) * Math.sqrt(viewport.scale));
        context.globalAlpha = selection
          ? selected || selectedNeighborIds.has(node.id)
            ? 1
            : 0.18
          : hasQuery
            ? matched
              ? 1
              : 0.14
            : 0.9;
        context.fillStyle = colorForGroup(node.group);
        context.strokeStyle = selected || hovered ? selectedColor : panelColor;
        context.lineWidth = selected ? 3 : hovered ? 2 : 1.2;
        context.beginPath();
        context.arc(point.x, point.y, selected ? radius + 1.5 : radius, 0, Math.PI * 2);
        context.fill();
        context.stroke();

        const shouldLabel =
          selected ||
          hovered ||
          (hasQuery && matched && labelsDrawn < labelBudget) ||
          (!hasQuery && graph.nodes.length <= 40);
        if (!shouldLabel) return;
        labelsDrawn += 1;
        context.globalAlpha = 1;
        context.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        context.textBaseline = 'middle';
        context.fillStyle = inkColor;
        const label = node.title.length > 36 ? `${node.title.slice(0, 33)}…` : node.title;
        context.fillText(label, point.x + radius + 5, point.y);
      });
      context.globalAlpha = 1;

      if (graph.nodes.length === 0) {
        context.fillStyle = quietColor;
        context.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('No graph nodes to display', width / 2, height / 2);
        context.textAlign = 'start';
      }
    }

    function scheduleDraw() {
      if (destroyed || scheduledFrame !== null) return;
      if (reducedMotion || typeof runtime.requestAnimationFrame !== 'function') {
        draw();
        return;
      }
      scheduledFrame = requestFrame(draw);
    }

    function emitViewport() {
      invoke(onViewportChange, { ...viewport });
    }

    function setSelection(selectedIdInput, settingsInput) {
      const settings = safeObject(settingsInput);
      const next = reconcileSelection(graph, selectedIdInput);
      const changed = next !== selection;
      selection = next;
      if (changed && settings.notify !== false) {
        invoke(onSelect, selection, graph.nodes.find((node) => node.id === selection) || null);
      }
      scheduleDraw();
      return selection;
    }

    function rememberViewState() {
      if (graph.nodes.length === 0) return;
      viewStates.set(graph.source, {
        positions: new Map(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
        viewport: { ...viewport }
      });
    }

    function restoreViewState(nextGraph) {
      const saved = viewStates.get(nextGraph.source);
      if (!saved) return false;
      let restoredNodeCount = 0;
      nextGraph.nodes.forEach((node) => {
        const position = saved.positions.get(node.id);
        if (!position) return;
        node.x = position.x;
        node.y = position.y;
        restoredNodeCount += 1;
      });
      if (restoredNodeCount === 0) return false;
      viewport = normalizedViewport(saved.viewport);
      return true;
    }

    function fit(paddingInput = 42) {
      const padding = Math.max(0, finite(paddingInput, 42));
      if (graph.nodes.length === 0) {
        viewport = { x: width / 2, y: height / 2, scale: 1 };
        fitWhenVisible = false;
        emitViewport();
        scheduleDraw();
        return { ...viewport };
      }
      if (width <= 1 || height <= 1) {
        fitWhenVisible = true;
        return { ...viewport };
      }
      let minimumX = Infinity;
      let maximumX = -Infinity;
      let minimumY = Infinity;
      let maximumY = -Infinity;
      graph.nodes.forEach((node) => {
        minimumX = Math.min(minimumX, node.x);
        maximumX = Math.max(maximumX, node.x);
        minimumY = Math.min(minimumY, node.y);
        maximumY = Math.max(maximumY, node.y);
      });
      const graphWidth = Math.max(40, maximumX - minimumX + 30);
      const graphHeight = Math.max(40, maximumY - minimumY + 30);
      const availableWidth = Math.max(1, width - padding * 2);
      const availableHeight = Math.max(1, height - padding * 2);
      const scale = clamp(
        Math.min(availableWidth / graphWidth, availableHeight / graphHeight),
        MIN_SCALE,
        MAX_SCALE
      );
      const centerX = (minimumX + maximumX) / 2;
      const centerY = (minimumY + maximumY) / 2;
      viewport = {
        x: width / 2 - centerX * scale,
        y: height / 2 - centerY * scale,
        scale
      };
      fitWhenVisible = false;
      emitViewport();
      scheduleDraw();
      return { ...viewport };
    }

    function setGraph(input, settingsInput) {
      const settings = safeObject(settingsInput);
      rememberViewState();
      graph = normalizeGraph(input);
      hover = null;
      const previousSelection = selection;
      selection = reconcileSelection(graph, previousSelection);
      const restored = restoreViewState(graph);
      if (selection !== previousSelection && settings.notifySelection === true) {
        invoke(onSelect, selection, graph.nodes.find((node) => node.id === selection) || null);
      }
      if (settings.fit === true || (settings.fit !== false && !restored)) {
        fit(settings.padding);
      } else {
        if (restored) emitViewport();
        scheduleDraw();
      }
      return graph;
    }

    function setQuery(value) {
      query = boundedText(value, '', 240);
      scheduleDraw();
      return search(graph, query, MAX_SEARCH_RESULTS);
    }

    function panBy(deltaXInput, deltaYInput) {
      viewport = {
        ...viewport,
        x: viewport.x + finite(deltaXInput),
        y: viewport.y + finite(deltaYInput)
      };
      emitViewport();
      scheduleDraw();
      return { ...viewport };
    }

    function zoom(factorInput, screenPointInput) {
      const point = screenPointInput
        ? normalizedPoint(screenPointInput)
        : { x: width / 2, y: height / 2 };
      viewport = zoomAt(viewport, point, factorInput);
      emitViewport();
      scheduleDraw();
      return { ...viewport };
    }

    function centerOn(nodeIdInput, settingsInput) {
      const settings = safeObject(settingsInput);
      const id = nodeId(nodeIdInput);
      const node = graph.nodes.find((candidate) => candidate.id === id);
      if (!node) return false;
      const scale = clamp(settings.scale ?? viewport.scale, MIN_SCALE, MAX_SCALE);
      viewport = {
        x: width / 2 - node.x * scale,
        y: height / 2 - node.y * scale,
        scale
      };
      setSelection(id, { notify: settings.notify !== false });
      emitViewport();
      scheduleDraw();
      return true;
    }

    /** Select and recenter one native-list result without rebuilding its layout. */
    function focusNode(nodeIdInput, settingsInput) {
      return centerOn(nodeIdInput, settingsInput);
    }

    function pointerDown(event) {
      if (destroyed || (event.button !== undefined && event.button !== 0)) return;
      const point = canvasPoint(canvas, event);
      const selectedNodeId = hitTest(graph, viewport, point, 14);
      interaction = {
        kind: selectedNodeId ? 'node' : 'pan',
        nodeId: selectedNodeId,
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        lastX: point.x,
        lastY: point.y,
        moved: false
      };
      if (selectedNodeId) setSelection(selectedNodeId);
      if (typeof canvas.setPointerCapture === 'function' && event.pointerId !== undefined) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (_error) {
          // The pointer may already have been released by the user agent.
        }
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
    }

    function pointerMove(event) {
      const point = canvasPoint(canvas, event);
      if (!interaction || interaction.pointerId !== event.pointerId) {
        const nextHover = hitTest(graph, viewport, point, 14);
        if (nextHover !== hover) {
          hover = nextHover;
          invoke(onHover, hover, graph.nodes.find((node) => node.id === hover) || null);
          scheduleDraw();
        }
        return;
      }
      const deltaX = point.x - interaction.lastX;
      const deltaY = point.y - interaction.lastY;
      interaction.lastX = point.x;
      interaction.lastY = point.y;
      if (Math.hypot(point.x - interaction.startX, point.y - interaction.startY) > 3) {
        interaction.moved = true;
      }
      if (interaction.kind === 'node' && interaction.nodeId) {
        const node = graph.nodes.find((candidate) => candidate.id === interaction.nodeId);
        if (node) {
          node.x += deltaX / viewport.scale;
          node.y += deltaY / viewport.scale;
        }
      } else {
        viewport = { ...viewport, x: viewport.x + deltaX, y: viewport.y + deltaY };
        emitViewport();
      }
      scheduleDraw();
      if (typeof event.preventDefault === 'function') event.preventDefault();
    }

    function endPointer(event) {
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      if (typeof canvas.releasePointerCapture === 'function' && event.pointerId !== undefined) {
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch (_error) {
          // Releasing an already-lost capture is harmless.
        }
      }
      interaction = null;
      if (typeof event.preventDefault === 'function') event.preventDefault();
    }

    function wheel(event) {
      const point = canvasPoint(canvas, event);
      const factor = Math.exp(-finite(event.deltaY) * 0.0015);
      zoom(factor, point);
      if (typeof event.preventDefault === 'function') event.preventDefault();
    }

    function pointerLeave() {
      if (interaction || hover === null) return;
      hover = null;
      invoke(onHover, null, null);
      scheduleDraw();
    }

    const listeners = [
      ['pointerdown', pointerDown],
      ['pointermove', pointerMove],
      ['pointerup', endPointer],
      ['pointercancel', endPointer],
      ['pointerleave', pointerLeave],
      ['wheel', wheel, { passive: false }]
    ];
    listeners.forEach(([name, listener, settings]) => {
      canvas.addEventListener(name, listener, settings);
    });

    let resizeObserver = null;
    const resizeListener = () => {
      measure();
      scheduleDraw();
    };
    if (typeof runtime.ResizeObserver === 'function') {
      resizeObserver = new runtime.ResizeObserver(resizeListener);
      resizeObserver.observe(canvas);
    } else if (typeof runtime.addEventListener === 'function') {
      runtime.addEventListener('resize', resizeListener);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.forEach(([name, listener, settings]) => {
        canvas.removeEventListener(name, listener, settings);
      });
      if (resizeObserver) resizeObserver.disconnect();
      else if (typeof runtime.removeEventListener === 'function') {
        runtime.removeEventListener('resize', resizeListener);
      }
      cancelFrame(scheduledFrame);
      scheduledFrame = null;
      interaction = null;
      viewStates.clear();
    }

    measure();
    scheduleDraw();

    return Object.freeze({
      centerOn,
      destroy,
      fit,
      focusNode,
      getGraph: () => graph,
      getSelection: () => selection,
      getViewport: () => ({ ...viewport }),
      panBy,
      render: draw,
      resize: resizeListener,
      setGraph,
      setQuery,
      setSelection,
      zoom
    });
  }

  return Object.freeze({
    MAX_SCALE,
    MAX_SEARCH_RESULTS,
    MIN_SCALE,
    createRenderer,
    hitTest,
    neighbors,
    normalizeGraph,
    reconcileSelection,
    search,
    zoomAt
  });
});
