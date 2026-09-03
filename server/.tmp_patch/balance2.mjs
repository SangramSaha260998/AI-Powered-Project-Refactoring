import fs from 'fs';

const file = process.argv[2] || 'src/services/migration.js';
const src = fs.readFileSync(file, 'utf8');

let depth = 0; // braces
let parens = 0;
let brackets = 0;
let i = 0;
let line = 1;

const isIdStart = (c) => /[A-Za-z_$]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);

while (i < src.length) {
  const c = src[i];
  const n = src[i + 1];

  if (c === '\n') { line++; i++; continue; }

  // comments
  if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
  if (c === '/' && n === '*') {
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
      if (src[i] === '\n') line++;
      i++;
    }
    i += 2;
    continue;
  }

  // strings
  if (c === "'" || c === '"') {
    const q = c;
    i++;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === q) { i++; break; }
      if (src[i] === '\n') line++;
      i++;
    }
    continue;
  }

  // template literals (handles nested ${})
  if (c === '`') {
    i++;
    let tplDepth = 0;
    let inCode = false;
    while (i < src.length) {
      const tc = src[i];
      if (tc === '\\') { i += 2; continue; }
      if (!inCode) {
        if (tc === '`') { i++; break; }
        if (tc === '$' && src[i + 1] === '{') { inCode = true; tplDepth = 1; i += 2; continue; }
        if (tc === '\n') line++;
        i++;
        continue;
      }
      // inside ${...} code
      if (tc === '{') { tplDepth++; i++; continue; }
      if (tc === '}') {
        tplDepth--;
        i++;
        if (tplDepth === 0) { inCode = false; }
        continue;
      }
      if (tc === "'" || tc === '"') {
        const q = tc;
        i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === q) { i++; break; }
          if (src[i] === '\n') line++;
          i++;
        }
        continue;
      }
      if (tc === '`') { // nested template inside ${}
        const saved = inCode;
        i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '`') { i++; break; }
          if (src[i] === '\n') line++;
          i++;
        }
        inCode = saved;
        continue;
      }
      if (tc === '/') {
        if (src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (src[i + 1] === '*') {
          i += 2;
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
            if (src[i] === '\n') line++;
            i++;
          }
          i += 2;
          continue;
        }
      }
      if (tc === '(') parens++;
      if (tc === ')') parens--;
      if (tc === '[') brackets++;
      if (tc === ']') brackets--;
      i++;
    }
    continue;
  }

  // regex literals (heuristic: /.../ not preceded by identifier/)/]/} — rare here)
  if (c === '/' && !isIdPart(n)) {
    // try regex: from previous significant char
    let prev = '';
    for (let j = i - 1; j >= 0 && src[j] !== '\n'; j--) {
      if (src[j] === ' ' || src[j] === '\t') continue;
      prev = src[j];
      break;
    }
    if (!/[)\]}A-Za-z0-9_$]/.test(prev)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        if (src[i] === ']') inClass = false;
        if (src[i] === '/' && !inClass) { i++; break; }
        if (src[i] === '\n') line++;
        i++;
      }
      continue;
    }
  }

  if (c === '{') depth++;
  if (c === '}') depth--;
  if (c === '(') parens++;
  if (c === ')') parens--;
  if (c === '[') brackets++;
  if (c === ']') brackets--;

  if (depth < 0) { console.log(`NEGATIVE brace at line ${line}`); depth = 0; }
  if (parens < 0) { console.log(`NEGATIVE paren at line ${line}`); parens = 0; }
  if (brackets < 0) { console.log(`NEGATIVE bracket at line ${line}`); brackets = 0; }
  i++;
}

console.log(`FINAL depth=${depth} parens=${parens} brackets=${brackets}`);
