/**
 * Helpers for cleaning multi-file unit-writer LLM output.
 */

const UNIT_FILE_MARKER_RE =
  /===== FILE:\s*(.+?)\s*=====\s*\r?\n([\s\S]*?)(?=\r?\n===== FILE:|(?:\r?\n)?===== END =====\s*$|$)/g;

const STANDALONE_FILE_MARKER_LINE = /^\s*===== FILE:\s*.+?\s*=====\s*$/gm;
const STANDALONE_END_MARKER_LINE = /^\s*===== END =====\s*$/gm;

/** True when content still contains unit-writer path markers. */
export function hasUnitWriterMarkers(content) {
  if (!content) return false;
  const text = String(content);
  return (
    /^\s*===== FILE:/m.test(text) ||
    /^\s*===== END =====\s*$/m.test(text) ||
    /\r?\n\s*===== FILE:/.test(text)
  );
}

/**
 * Remove ===== FILE: path ===== / ===== END ===== markers from generated source.
 * When a single file body was leaked inside markers, returns only that body.
 */
export function stripUnitWriterMarkers(content) {
  if (!content) return '';
  let text = String(content).trim();
  if (!hasUnitWriterMarkers(text)) return text;

  const parsed = [];
  let match;
  const re = new RegExp(UNIT_FILE_MARKER_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    parsed.push({
      path: match[1].trim().replace(/^[`'"]+|[`'"]+$/g, ''),
      content: match[2].replace(/\n+$/, '')
    });
  }

  if (parsed.length === 1) {
    return parsed[0].content.trimEnd();
  }

  text = text
    .replace(STANDALONE_FILE_MARKER_LINE, '')
    .replace(STANDALONE_END_MARKER_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  return text;
}
