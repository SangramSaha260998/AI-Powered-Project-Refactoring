import fs from 'fs';

const s = fs.readFileSync('.tmp_patch/orig.js', 'utf8');
const lines = s.split(/\r?\n/);
let depth = 0;
let inStr = null; // ' " ` or null
let inLine = false;
let inBlock = false;

for (let li = 0; li < lines.length; li++) {
  const l = lines[li];
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    const n = l[i + 1];

    if (inLine) {
      inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (inStr === '`') {
        if (c === '$' && n === '{') { depth++; inStr = null; i++; continue; }
        if (c === '`') inStr = null;
      } else if (c === inStr) {
        inStr = null;
      }
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) { console.log(`NEGATIVE at line ${li + 1}: ${l}`); depth = 0; }
    }
  }
  // template literal spanning lines: if we ended the line inside a backtick, keep inStr
}
console.log('FINAL DEPTH:', depth);
