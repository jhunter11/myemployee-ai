import { describe, expect, it } from 'vitest';

import {
  isRoutePreset,
  parseFlags,
  routeInputForPreset,
  splitList
} from '../../src/models/runtime-cli-support';

describe('runtime CLI support', () => {
  describe('parseFlags', () => {
    const spec = { boolean: ['--json'], value: ['--message', '--route'] } as const;

    it('separates positionals, booleans, and value flags', () => {
      const parsed = parseFlags(['status', '--json', '--message', 'hi', '--route', 'local'], spec);
      expect(parsed.positional).toEqual(['status']);
      expect(parsed.booleans.has('--json')).toBe(true);
      expect(parsed.values.get('--message')).toBe('hi');
      expect(parsed.values.get('--route')).toBe('local');
    });

    it('skips undefined argv holes without throwing', () => {
      const argv: string[] = [];
      argv[1] = '--json'; // index 0 is a hole (undefined)
      const parsed = parseFlags(argv, spec);
      expect(parsed.booleans.has('--json')).toBe(true);
    });

    it('rejects an unsupported flag and sanitizes a non-flag-looking token', () => {
      expect(() => parseFlags(['--nope'], spec)).toThrow(/Unsupported argument: --nope/);
      expect(() => parseFlags(['--bad9'], spec)).toThrow(/non-flag-token/);
    });

    it('rejects a duplicate value flag', () => {
      expect(() => parseFlags(['--message', 'a', '--message', 'b'], spec)).toThrow(
        /Duplicate argument: --message/
      );
    });

    it('rejects a value flag with no value (end of argv or another flag)', () => {
      expect(() => parseFlags(['--message'], spec)).toThrow(/requires a direct value/);
      expect(() => parseFlags(['--message', '--json'], spec)).toThrow(/requires a direct value/);
    });
  });

  describe('routeInputForPreset', () => {
    it('maps local to tier-1 summarization work', () => {
      expect(routeInputForPreset('local')).toMatchObject({
        workType: 'summarization',
        risk: 'low'
      });
    });
    it('maps economy to tier-2 synthesis work', () => {
      expect(routeInputForPreset('economy')).toMatchObject({ workType: 'synthesis', risk: 'low' });
    });
    it('maps frontier to tier-3 high-risk synthesis work', () => {
      expect(routeInputForPreset('frontier')).toMatchObject({
        workType: 'synthesis',
        risk: 'high'
      });
    });
    it('threads a custom operation label', () => {
      expect(routeInputForPreset('local', 'faceless_script').operation).toBe('faceless_script');
    });
  });

  describe('isRoutePreset', () => {
    it('accepts known presets and rejects others', () => {
      expect(isRoutePreset('local')).toBe(true);
      expect(isRoutePreset('economy')).toBe(true);
      expect(isRoutePreset('frontier')).toBe(true);
      expect(isRoutePreset('ultra')).toBe(false);
    });
  });

  describe('splitList', () => {
    it('returns an empty list for undefined and trims/filters entries', () => {
      expect(splitList(undefined)).toEqual([]);
      expect(splitList('a, b ,, c ')).toEqual(['a', 'b', 'c']);
    });
  });
});
