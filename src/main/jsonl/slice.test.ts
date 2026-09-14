import { describe, expect, it } from 'vitest';
import { sliceObject, readString, readNumber, readJSON, type Slices } from './slice.js';

function slice(json: string, keys: string[]): Slices {
  const out: Slices = new Map();
  sliceObject(json, 0, new Set(keys), out);
  return out;
}

describe('sliceObject', () => {
  it('finds top-level keys regardless of position', () => {
    const json = '{"a":1,"b":"two","c":true,"d":null}';
    const s = slice(json, ['a', 'b', 'c', 'd']);
    expect(readNumber(json, s.get('a'))).toBe(1);
    expect(readString(json, s.get('b'))).toBe('two');
    expect(json.slice(...s.get('c')!)).toBe('true');
    expect(json.slice(...s.get('d')!)).toBe('null');
  });

  it('does not descend into nested objects or arrays', () => {
    // The nested `type` must not win over the top-level one — Claude's format
    // puts `message` (which contains "type":"message") before the real `type`.
    const json = '{"message":{"type":"message","model":"m"},"type":"assistant"}';
    const s = slice(json, ['type']);
    expect(readString(json, s.get('type'))).toBe('assistant');
  });

  it('ignores keys that appear inside string values', () => {
    const json = '{"text":"\\"type\\":\\"user\\" and {\\"a\\":1}","type":"assistant"}';
    const s = slice(json, ['type']);
    expect(readString(json, s.get('type'))).toBe('assistant');
  });

  it('handles escapes, including a trailing backslash before the closing quote', () => {
    const json = '{"a":"back\\\\","type":"user"}';
    const s = slice(json, ['a', 'type']);
    expect(readString(json, s.get('a'))).toBe('back\\');
    expect(readString(json, s.get('type'))).toBe('user');
  });

  it('decodes escaped keys and escaped string values', () => {
    const json = '{"a\\u0062c":"x","q":"line\\nbreak \\u00e9"}';
    const s = slice(json, ['abc', 'q']);
    expect(readString(json, s.get('abc'))).toBe('x');
    expect(readString(json, s.get('q'))).toBe('line\nbreak é');
  });

  it('skips deeply nested structures and whitespace', () => {
    const json = '{ "big" : { "a" : [ 1 , { "b" : [ [ ] , { } ] } ] } , "type" : "user" }';
    const s = slice(json, ['type']);
    expect(readString(json, s.get('type'))).toBe('user');
  });

  it('returns the first occurrence of a duplicated key', () => {
    const json = '{"type":"first","type":"second"}';
    const s = slice(json, ['type']);
    expect(readString(json, s.get('type'))).toBe('first');
  });

  it('can be re-entered at a nested object to read its fields', () => {
    const json = '{"message":{"model":"opus","usage":{"input_tokens":5},"stop_reason":"end_turn"}}';
    const top = slice(json, ['message']);
    const msg: Slices = new Map();
    sliceObject(json, top.get('message')![0], new Set(['model', 'usage', 'stop_reason']), msg);
    expect(readString(json, msg.get('model'))).toBe('opus');
    expect(readString(json, msg.get('stop_reason'))).toBe('end_turn');
    expect(readJSON<{ input_tokens: number }>(json, msg.get('usage'))?.input_tokens).toBe(5);
  });

  it('matches JSON.parse on a large line where the payload dwarfs the fields', () => {
    const big = 'x'.repeat(200_000);
    const json = JSON.stringify({
      parentUuid: null,
      message: { role: 'user', content: [{ type: 'tool_result', text: big }] },
      type: 'user',
      timestamp: '2026-09-14T10:00:00.000Z',
      cwd: '/Users/me/proj',
      gitBranch: 'main',
    });
    const s = slice(json, ['type', 'timestamp', 'cwd', 'gitBranch']);
    const ref = JSON.parse(json);
    expect(readString(json, s.get('type'))).toBe(ref.type);
    expect(readString(json, s.get('timestamp'))).toBe(ref.timestamp);
    expect(readString(json, s.get('cwd'))).toBe(ref.cwd);
    expect(readString(json, s.get('gitBranch'))).toBe(ref.gitBranch);
  });

  it('returns undefined for absent keys and wrong-typed reads', () => {
    const json = '{"a":1}';
    const s = slice(json, ['a', 'missing']);
    expect(readString(json, s.get('missing'))).toBeUndefined();
    expect(readNumber(json, s.get('missing'))).toBeUndefined();
    expect(readJSON(json, s.get('missing'))).toBeUndefined();
    // `a` holds a number, not a string.
    expect(readString(json, s.get('a'))).toBeUndefined();
  });

  it('gives up on malformed input without throwing or hanging', () => {
    for (const bad of ['', '{', 'null', '[1,2]', '{"a"', '{"a":', '{"a":"unterminated']) {
      expect(() => slice(bad, ['a'])).not.toThrow();
    }
  });
});
