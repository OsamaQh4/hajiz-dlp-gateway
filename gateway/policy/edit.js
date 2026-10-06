/*
 * Text-preserving edits to policy.yaml.
 *
 * The obvious implementation is yaml.load, mutate, yaml.dump. It is also
 * wrong here. This file is the product's control surface and most of it is
 * comments - the reasoning for why credentials are redacted rather than
 * blocked, what the gate measurement showed, what the ratchet is for. A dump
 * round trip deletes all of it, reorders the keys, and hands back something an
 * administrator no longer recognises as the file they wrote. The first edit
 * from the console would silently destroy the documentation the file exists to
 * carry.
 *
 * So edits are made to the text: find the line holding a key at a path, change
 * the value after the colon, leave everything else exactly as it was. Anything
 * this cannot express is refused rather than guessed at, and the caller falls
 * back to asking a person to edit the file.
 */

/** Indentation of a line, or -1 for a blank or comment-only line. */
function indentOf(line) {
  if (!line.trim() || line.trim().startsWith('#')) return -1;
  return line.length - line.trimStart().length;
}

/** The key a line declares, or null if it declares none. */
function keyOf(line) {
  const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:/);
  return m ? m[1] : null;
}

/**
 * Find the line index declaring `path`, e.g. ['actions','email'].
 * @returns {{line:number, indent:number}|null}
 */
export function findKey(text, path) {
  const lines = text.split('\n');
  let depth = 0;
  let parentIndent = -1;
  let from = 0;

  while (depth < path.length) {
    let found = -1;
    for (let i = from; i < lines.length; i += 1) {
      const indent = indentOf(lines[i]);
      if (indent === -1) continue;
      // Left the parent's block without finding the key.
      if (depth > 0 && indent <= parentIndent) break;
      if (depth === 0 && indent !== 0) continue;
      if (depth > 0 && indent !== parentIndent + 2 && indent <= parentIndent) break;
      if (keyOf(lines[i]) === path[depth]) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    if (depth === path.length - 1) return { line: found, indent: indentOf(lines[found]) };
    parentIndent = indentOf(lines[found]);
    from = found + 1;
    depth += 1;
  }
  return null;
}

/**
 * Replace the scalar value at `path`, keeping the key, its indentation and any
 * trailing comment on the line.
 *
 * @returns {string} the new text
 * @throws if the key is not present, or does not hold a scalar
 */
export function setScalar(text, path, value) {
  const at = findKey(text, path);
  if (!at) throw new Error(`policy.yaml has no ${path.join('.')} to change`);

  const lines = text.split('\n');
  const line = lines[at.line];
  const after = line.slice(line.indexOf(':') + 1);

  // A key whose value is a block (a nested mapping or a list) has nothing
  // after the colon. Rewriting that line would orphan everything beneath it.
  if (!after.trim() || after.trim().startsWith('#')) {
    throw new Error(`${path.join('.')} is a block, not a single value`);
  }

  const comment = after.match(/\s+#.*$/)?.[0] ?? '';
  lines[at.line] = `${line.slice(0, line.indexOf(':') + 1)} ${formatScalar(value)}${comment}`;
  return lines.join('\n');
}

function formatScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  // Quote anything that YAML would read as something other than a plain string.
  return /^[A-Za-z0-9_][A-Za-z0-9 _.\/-]*$/.test(s) ? s : JSON.stringify(s);
}

/**
 * Replace the items of a list, keeping the key line and the comments above it.
 * Used for the watchlist, which is a flat list of strings.
 */
export function setList(text, path, items) {
  const at = findKey(text, path);
  if (!at) throw new Error(`policy.yaml has no ${path.join('.')} to change`);

  const lines = text.split('\n');
  let end = at.line + 1;
  while (end < lines.length) {
    const indent = indentOf(lines[end]);
    if (indent === -1) {
      end += 1;
      continue;
    }
    if (indent <= at.indent) break;
    end += 1;
  }

  // Trailing blank lines belong to whatever comes next, not to this block.
  let last = end;
  while (last > at.line + 1 && !lines[last - 1].trim()) last -= 1;

  const body = items.map((item) => `${' '.repeat(at.indent + 2)}- ${formatScalar(item)}`);
  lines.splice(at.line + 1, last - (at.line + 1), ...body);
  return lines.join('\n');
}

/**
 * Apply a set of changes, each { path: string[], value } or { path, list }.
 * All or nothing: one bad path leaves the file untouched.
 */
export function applyEdits(text, edits) {
  let next = text;
  for (const edit of edits) {
    next = edit.list ? setList(next, edit.path, edit.list) : setScalar(next, edit.path, edit.value);
  }
  return next;
}
