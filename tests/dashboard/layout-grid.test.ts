import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const layout = require('../../public/dashboard/assets/layout-grid.js') as {
  SIZES: Record<string, number>;
  SIZE_NAMES: string[];
  MAX_TILES: number;
  STORAGE_KEY: string;
  DEFAULT_SIZE: string;
  addTile(layout: unknown, widget: string, size?: string): Layout;
  availableToAdd(layout: unknown, ids: string[]): string[];
  defaultLayout(ids: string[]): Layout;
  isLocked(layout: unknown): boolean;
  load(storage: unknown, ids: string[]): Layout;
  moveTile(layout: unknown, id: string, delta: number): Layout;
  normalize(raw: unknown, ids: string[]): Layout;
  removeTile(layout: unknown, id: string): Layout;
  resizeTile(layout: unknown, id: string, size: string): Layout;
  save(storage: unknown, layout: unknown): boolean;
  serialize(layout: unknown): string;
  setLocked(layout: unknown, locked: boolean): Layout;
  spanFor(size: string): number;
};

interface Layout {
  version: number;
  locked: boolean;
  tiles: Array<{ id: string; widget: string; size: string; span: number }>;
}

const WIDGETS = ['health', 'run-supervision', 'sleeve-pnl', 'work-queue', 'clients'];

function unlockedBoard(): Layout {
  return layout.normalize({ locked: false, tiles: [{ widget: 'health', size: 'small' }] }, WIDGETS);
}

/** Indexed access is checked, so assert presence once here instead of inline. */
function tileAt(board: Layout, index: number): Layout['tiles'][number] {
  const tile = board.tiles[index];
  if (tile === undefined) throw new Error(`Expected a tile at index ${index}`);
  return tile;
}

function fakeStorage(initial?: string) {
  const cell = { value: initial };
  return {
    getItem: () => cell.value,
    setItem: (_key: string, value: string) => {
      cell.value = value;
    },
    read: () => cell.value
  };
}

describe('dashboard layout grid', () => {
  it('opens a default board drawn only from registered widgets', () => {
    const board = layout.defaultLayout(WIDGETS);

    expect(board.locked).toBe(false);
    expect(board.tiles.length).toBeGreaterThan(0);
    board.tiles.forEach((tile) => expect(WIDGETS).toContain(tile.widget));
  });

  it('drops widgets that are no longer registered instead of rendering an error tile', () => {
    const board = layout.normalize(
      {
        locked: false,
        tiles: [
          { widget: 'health', size: 'small' },
          { widget: 'widget-that-was-renamed', size: 'full' }
        ]
      },
      WIDGETS
    );

    expect(board.tiles.map((tile) => tile.widget)).toEqual(['health']);
  });

  it('resolves every size name to a span within the twelve column grid', () => {
    layout.SIZE_NAMES.forEach((name) => {
      const span = layout.spanFor(name);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(12);
    });
    expect(layout.spanFor('not-a-size')).toBe(layout.SIZES[layout.DEFAULT_SIZE]);
  });

  describe('lock', () => {
    it('refuses every shape change while locked', () => {
      const locked = layout.setLocked(unlockedBoard(), true);
      const target = tileAt(locked, 0).id;

      expect(layout.addTile(locked, 'sleeve-pnl')).toBe(locked);
      expect(layout.removeTile(locked, target)).toBe(locked);
      expect(layout.resizeTile(locked, target, 'full')).toBe(locked);
      expect(layout.moveTile(locked, target, 1)).toBe(locked);
    });

    it('still allows unlocking, so a locked board is never a dead end', () => {
      const locked = layout.setLocked(unlockedBoard(), true);

      expect(layout.isLocked(locked)).toBe(true);
      expect(layout.isLocked(layout.setLocked(locked, false))).toBe(false);
    });

    it('never opens an empty board in a locked state', () => {
      const board = layout.normalize({ locked: true, tiles: [] }, []);

      expect(board.tiles).toEqual([]);
      expect(board.locked).toBe(false);
    });
  });

  describe('mutation while unlocked', () => {
    it('adds, resizes, reorders, and removes tiles', () => {
      let board = unlockedBoard();

      board = layout.addTile(board, 'sleeve-pnl', 'full');
      expect(board.tiles.map((tile) => tile.widget)).toEqual(['health', 'sleeve-pnl']);
      expect(tileAt(board, 1).span).toBe(12);

      board = layout.resizeTile(board, tileAt(board, 1).id, 'small');
      expect(tileAt(board, 1).size).toBe('small');

      board = layout.moveTile(board, tileAt(board, 1).id, -1);
      expect(board.tiles.map((tile) => tile.widget)).toEqual(['sleeve-pnl', 'health']);

      board = layout.removeTile(board, tileAt(board, 0).id);
      expect(board.tiles.map((tile) => tile.widget)).toEqual(['health']);
    });

    it('rejects an unknown size rather than falling back silently on resize', () => {
      const board = unlockedBoard();

      expect(layout.resizeTile(board, tileAt(board, 0).id, 'enormous')).toBe(board);
    });

    it('refuses to move a tile past either end', () => {
      const board = layout.addTile(unlockedBoard(), 'sleeve-pnl');

      expect(layout.moveTile(board, tileAt(board, 0).id, -1)).toBe(board);
      expect(layout.moveTile(board, tileAt(board, 1).id, 1)).toBe(board);
    });

    it('caps the board so it cannot grow without bound', () => {
      let board = layout.normalize({ locked: false, tiles: [] }, WIDGETS);
      for (let index = 0; index < layout.MAX_TILES + 4; index += 1) {
        board = layout.addTile(board, 'health');
      }

      expect(board.tiles.length).toBe(layout.MAX_TILES);
    });

    it('offers only widgets that are not already placed', () => {
      const board = layout.normalize({ locked: false, tiles: [{ widget: 'health' }] }, WIDGETS);

      expect(layout.availableToAdd(board, WIDGETS)).not.toContain('health');
      expect(layout.availableToAdd(board, WIDGETS)).toContain('sleeve-pnl');
    });
  });

  describe('persistence', () => {
    it('round-trips a board through storage including its lock state', () => {
      const storage = fakeStorage();
      const board = layout.setLocked(layout.addTile(unlockedBoard(), 'sleeve-pnl', 'full'), true);

      expect(layout.save(storage, board)).toBe(true);
      const restored = layout.load(storage, WIDGETS);

      expect(restored.locked).toBe(true);
      expect(restored.tiles.map((tile) => [tile.widget, tile.size])).toEqual([
        ['health', 'small'],
        ['sleeve-pnl', 'full']
      ]);
    });

    it('reopens a deliberately cleared board empty instead of restoring the defaults', () => {
      const storage = fakeStorage();
      let board = unlockedBoard();
      board = layout.removeTile(board, tileAt(board, 0).id);
      expect(board.tiles).toEqual([]);
      layout.save(storage, board);

      expect(layout.load(storage, WIDGETS).tiles).toEqual([]);
    });

    it('restores the defaults when every stored tile was dropped as unregistered', () => {
      const storage = fakeStorage(
        JSON.stringify({ version: 1, locked: false, tiles: [{ widget: 'renamed', size: 'small' }] })
      );

      expect(layout.load(storage, WIDGETS).tiles.length).toBeGreaterThan(0);
    });

    it('falls back to the default board when stored JSON is corrupt', () => {
      const restored = layout.load(fakeStorage('{not json'), WIDGETS);

      expect(restored.tiles.length).toBeGreaterThan(0);
    });

    it('survives storage that throws, as in private browsing', () => {
      const hostile = {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        }
      };

      expect(layout.load(hostile, WIDGETS).tiles.length).toBeGreaterThan(0);
      expect(layout.save(hostile, unlockedBoard())).toBe(false);
    });
  });
});
