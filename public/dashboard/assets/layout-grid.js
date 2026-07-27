(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JarvisDashboardLayout = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  /**
   * Layout model for the configurable main dashboard.
   *
   * The operator composes the main page from widgets that also live on their own
   * views, chooses each tile's width, then locks the layout. Lock is enforced
   * *here*, in the model, rather than only by dropping CSS affordances: every
   * mutation returns the layout unchanged while locked, so a stray drag, a
   * mis-click, or a replayed event cannot reshape a locked board.
   *
   * Every function is pure. Callers own persistence and pass storage in, which
   * keeps the rules testable without a DOM or a browser.
   */

  const VERSION = 1;
  const MAX_TILES = 12;
  const STORAGE_KEY = 'jarvis.dashboard.layout.v1';

  /** Tile widths as spans of a 12-column grid. */
  const SIZES = Object.freeze({
    small: 3,
    medium: 6,
    large: 9,
    full: 12
  });
  const SIZE_NAMES = Object.freeze(Object.keys(SIZES));
  const DEFAULT_SIZE = 'medium';

  /**
   * The opening board. Chosen to answer "is anything wrong, what is running,
   * and what is it costing" without scrolling.
   */
  const DEFAULT_TILES = Object.freeze([
    Object.freeze({ widget: 'health', size: 'small' }),
    Object.freeze({ widget: 'run-supervision', size: 'large' }),
    Object.freeze({ widget: 'sleeve-pnl', size: 'medium' }),
    Object.freeze({ widget: 'work-queue', size: 'medium' })
  ]);

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function isSize(value) {
    return typeof value === 'string' && Object.hasOwn(SIZES, value);
  }

  function spanFor(size) {
    return SIZES[isSize(size) ? size : DEFAULT_SIZE];
  }

  /** Tile ids are positional and deterministic, so no clock or RNG is needed. */
  function tileId(widget, index) {
    return `${widget}::${index}`;
  }

  function tile(widget, size, index) {
    return Object.freeze({
      id: tileId(widget, index),
      widget,
      size: isSize(size) ? size : DEFAULT_SIZE,
      span: spanFor(size)
    });
  }

  function freezeLayout(locked, tiles) {
    return Object.freeze({
      version: VERSION,
      locked: locked === true,
      tiles: Object.freeze(tiles.map((entry, index) => tile(entry.widget, entry.size, index)))
    });
  }

  /**
   * Repair any persisted or hand-edited value into a valid layout. Unknown
   * widgets are dropped rather than rendered as errors, because a layout saved
   * before a widget was renamed should still open.
   */
  function normalize(raw, availableWidgetIds) {
    const available = new Set(safeArray(availableWidgetIds).filter((id) => typeof id === 'string'));
    const source = safeObject(raw);
    // A `tiles` array is the operator's stated board. Anything else — absent,
    // corrupt, the wrong type — means no board was stated at all.
    const stated = Array.isArray(source.tiles) ? source.tiles : null;
    const candidates = safeArray(stated)
      .map((entry) => safeObject(entry))
      .filter((entry) => typeof entry.widget === 'string' && available.has(entry.widget))
      .slice(0, MAX_TILES);
    // Falling back to the default board is only right when nothing was stated,
    // or when every stated tile was dropped as unregistered. An operator who
    // cleared the board chose an empty one and must get an empty one back.
    const cleared = stated !== null && stated.length === 0;
    const tiles =
      candidates.length > 0 || cleared
        ? candidates
        : DEFAULT_TILES.filter((entry) => available.has(entry.widget));
    // A locked empty board would be unrecoverable through the UI, so an empty
    // layout always opens unlocked regardless of what was persisted.
    return freezeLayout(tiles.length === 0 ? false : source.locked, tiles);
  }

  function defaultLayout(availableWidgetIds) {
    return normalize({ locked: false, tiles: DEFAULT_TILES }, availableWidgetIds);
  }

  function isLocked(layout) {
    return safeObject(layout).locked === true;
  }

  function setLocked(layout, locked) {
    const current = safeObject(layout);
    return freezeLayout(locked === true, safeArray(current.tiles));
  }

  function addTile(layout, widget, size) {
    const current = safeObject(layout);
    if (isLocked(current)) return layout;
    const tiles = safeArray(current.tiles);
    if (tiles.length >= MAX_TILES || typeof widget !== 'string' || widget.length === 0) {
      return layout;
    }
    return freezeLayout(current.locked, [...tiles, { widget, size }]);
  }

  function removeTile(layout, id) {
    const current = safeObject(layout);
    if (isLocked(current)) return layout;
    const tiles = safeArray(current.tiles).filter((entry) => entry.id !== id);
    if (tiles.length === safeArray(current.tiles).length) return layout;
    return freezeLayout(current.locked, tiles);
  }

  function resizeTile(layout, id, size) {
    const current = safeObject(layout);
    if (isLocked(current) || !isSize(size)) return layout;
    let changed = false;
    const tiles = safeArray(current.tiles).map((entry) => {
      if (entry.id !== id) return entry;
      changed = true;
      return { ...entry, size };
    });
    return changed ? freezeLayout(current.locked, tiles) : layout;
  }

  /** Reorder by one step. `delta` of -1 moves a tile earlier, +1 later. */
  function moveTile(layout, id, delta) {
    const current = safeObject(layout);
    if (isLocked(current) || (delta !== -1 && delta !== 1)) return layout;
    const tiles = [...safeArray(current.tiles)];
    const index = tiles.findIndex((entry) => entry.id === id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= tiles.length) return layout;
    [tiles[index], tiles[target]] = [tiles[target], tiles[index]];
    return freezeLayout(current.locked, tiles);
  }

  /** Widgets not yet placed, so the picker only offers what is addable. */
  function availableToAdd(layout, availableWidgetIds) {
    const placed = new Set(safeArray(safeObject(layout).tiles).map((entry) => entry.widget));
    return Object.freeze(
      safeArray(availableWidgetIds).filter((id) => typeof id === 'string' && !placed.has(id))
    );
  }

  function serialize(layout) {
    const current = normalize(
      layout,
      safeArray(safeObject(layout).tiles).map((entry) => safeObject(entry).widget)
    );
    return JSON.stringify({
      version: VERSION,
      locked: current.locked,
      tiles: current.tiles.map(({ widget, size }) => ({ widget, size }))
    });
  }

  /**
   * Read a layout from an injected storage object. Any parse or access failure
   * falls back to the default board: a corrupt value must never blank the page.
   */
  function load(storage, availableWidgetIds) {
    try {
      const raw = storage?.getItem?.(STORAGE_KEY);
      if (typeof raw !== 'string' || raw.length === 0) return defaultLayout(availableWidgetIds);
      return normalize(JSON.parse(raw), availableWidgetIds);
    } catch {
      return defaultLayout(availableWidgetIds);
    }
  }

  function save(storage, layout) {
    try {
      storage?.setItem?.(STORAGE_KEY, serialize(layout));
      return true;
    } catch {
      // Private-mode or quota failures must not break interaction.
      return false;
    }
  }

  return Object.freeze({
    DEFAULT_SIZE,
    MAX_TILES,
    SIZES,
    SIZE_NAMES,
    STORAGE_KEY,
    VERSION,
    addTile,
    availableToAdd,
    defaultLayout,
    isLocked,
    load,
    moveTile,
    normalize,
    removeTile,
    resizeTile,
    save,
    serialize,
    setLocked,
    spanFor
  });
});
