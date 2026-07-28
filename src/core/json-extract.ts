/**
 * Pulls a JSON object out of a larger text blob, given a marker that precedes it.
 *
 * YouTube embeds ytInitialPlayerResponse and ytInitialData as inline script assignments.
 * A regex like /ytInitialPlayerResponse\s*=\s*(\{.+?\});/ looks tempting and is wrong:
 * these blobs are hundreds of kilobytes of nested JSON containing caption text that is
 * full of braces, quotes, and semicolons. The only correct way to find the end is to
 * balance the braces while tracking string and escape state.
 */

const OPENERS: Record<string, string> = { '{': '}', '[': ']' };

/**
 * Returns the JSON text starting at the first `{` or `[` after `marker`, or null if the
 * marker is absent or the structure never closes.
 *
 * `fromIndex` lets callers walk past a failed candidate and try the next occurrence.
 */
export function extractJsonAfter(
  text: string,
  marker: string,
  fromIndex = 0,
): { json: string; endIndex: number } | null {
  const markerIndex = text.indexOf(marker, fromIndex);
  if (markerIndex === -1) return null;

  let start = -1;
  for (let i = markerIndex + marker.length; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch in OPENERS) {
      start = i;
      break;
    }
    // Only whitespace and the assignment punctuation may sit between the marker and
    // the value. Anything else means this occurrence is not an assignment we want,
    // for example a mention of the name inside another string.
    if (!/[\s=:]/.test(ch)) return null;
  }
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch in OPENERS) {
      stack.push(OPENERS[ch]!);
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) {
        return { json: text.slice(start, i + 1), endIndex: i + 1 };
      }
    }
  }

  return null;
}

/**
 * Finds and parses the first well-formed JSON value following any occurrence of `marker`.
 *
 * Tries every occurrence in turn, because the name can appear in a preload hint or an
 * unrelated string before the real assignment. Never throws.
 */
export function parseJsonAfter<T = unknown>(text: string, marker: string): T | null {
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerIndex = text.indexOf(marker, searchFrom);
    if (markerIndex === -1) return null;

    const found = extractJsonAfter(text, marker, searchFrom);
    if (found) {
      try {
        return JSON.parse(found.json) as T;
      } catch {
        searchFrom = found.endIndex;
        continue;
      }
    }
    searchFrom = markerIndex + marker.length;
  }

  return null;
}
