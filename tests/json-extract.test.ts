import { describe, expect, it } from 'vitest';
import { extractJsonAfter, parseJsonAfter } from '../src/core/json-extract.ts';

describe('extractJsonAfter', () => {
  it('stops at the matching brace, not the first one inside a string', () => {
    const text = 'var ytInitialPlayerResponse = {"caption":"a } b {","n":1};</script>';
    const found = extractJsonAfter(text, 'ytInitialPlayerResponse');

    expect(found).not.toBeNull();
    expect(JSON.parse(found!.json)).toEqual({ caption: 'a } b {', n: 1 });
  });

  it('handles escaped quotes inside strings', () => {
    const text = 'x = {"quote":"he said \\"} \\\\" ,"ok":true};';
    const found = extractJsonAfter(text, 'x');

    expect(found).not.toBeNull();
    expect(JSON.parse(found!.json)).toEqual({ quote: 'he said "} \\', ok: true });
  });

  it('handles nested arrays and objects', () => {
    const text = 'data = {"a":[{"b":[1,2]},{"c":{}}]}; more';
    const found = extractJsonAfter(text, 'data');

    expect(JSON.parse(found!.json)).toEqual({ a: [{ b: [1, 2] }, { c: {} }] });
  });

  it('returns null when the structure never closes', () => {
    expect(extractJsonAfter('a = {"b":1', 'a')).toBeNull();
  });

  it('returns null when the marker is absent', () => {
    expect(extractJsonAfter('nothing here', 'missing')).toBeNull();
  });

  it('refuses a marker that is not followed by a value', () => {
    // The name appears inside a string, not as an assignment.
    expect(extractJsonAfter('"see ytInitialData for details"', 'ytInitialData')).toBeNull();
  });
});

describe('parseJsonAfter', () => {
  it('skips a mention of the name and finds the real assignment', () => {
    const text = 'log("ytInitialData missing"); window.ytInitialData = {"ok":1};';
    expect(parseJsonAfter(text, 'ytInitialData')).toEqual({ ok: 1 });
  });

  it('skips an occurrence whose JSON does not parse and tries the next', () => {
    const text = 'v = {"a":undefined}; v = {"a":2};';
    expect(parseJsonAfter(text, 'v')).toEqual({ a: 2 });
  });

  it('supports the bracket assignment spelling with an explicit marker', () => {
    const text = 'window["ytInitialData"] = {"ok":true};';
    expect(parseJsonAfter(text, 'ytInitialData"] =')).toEqual({ ok: true });
  });

  it('returns null rather than throwing on junk', () => {
    expect(parseJsonAfter('completely unrelated text', 'ytInitialData')).toBeNull();
  });
});
