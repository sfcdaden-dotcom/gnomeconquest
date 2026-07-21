import { describe, expect, it } from 'vitest';
import {
  PRESET_DESCRIPTION_MAX_LENGTH,
  PRESET_LABEL_MAX_LENGTH,
  buildCustomPresetDef,
  parseCustomPresetFile,
  reservedHomePositions,
} from './customPresets';

describe('customPresets', () => {
  it('round-trips a valid preset file', () => {
    const def = buildCustomPresetDef('custom:x', 'My Layout', 'A blurb', 7, [
      { pos: { x: 1, y: 1 }, type: 'tunnel' },
      { pos: { x: 5, y: 5 }, type: 'flytrap' },
    ]);
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: def.label,
      description: def.description,
      boardSize: 7,
      gardens: def.build(7),
    });
    const parsed = parseCustomPresetFile(json);
    expect(parsed.label).toBe('My Layout');
    expect(parsed.build(7)).toEqual([
      { pos: { x: 1, y: 1 }, type: 'tunnel' },
      { pos: { x: 5, y: 5 }, type: 'flytrap' },
    ]);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => parseCustomPresetFile('not json')).toThrow();
  });

  it('rejects a file of the wrong kind', () => {
    expect(() => parseCustomPresetFile(JSON.stringify({ kind: 'something-else' }))).toThrow();
  });

  it('rejects a garden placed on a reserved Home Garden space', () => {
    const [west] = reservedHomePositions(7);
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [{ pos: west, type: 'tunnel' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/Home Garden/);
  });

  it('rejects an out-of-bounds garden', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [{ pos: { x: 9, y: 9 }, type: 'tunnel' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow();
  });

  it('rejects an unknown garden type', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [{ pos: { x: 1, y: 1 }, type: 'home' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow();
  });

  it('truncates an oversized label/description instead of rejecting the file', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'x'.repeat(PRESET_LABEL_MAX_LENGTH + 50),
      description: 'y'.repeat(PRESET_DESCRIPTION_MAX_LENGTH + 50),
      boardSize: 7,
      gardens: [],
    });
    const parsed = parseCustomPresetFile(json);
    expect(parsed.label).toHaveLength(PRESET_LABEL_MAX_LENGTH);
    expect(parsed.description).toHaveLength(PRESET_DESCRIPTION_MAX_LENGTH);
  });

  it('rejects a future file version', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 99,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/newer version/);
  });
});
