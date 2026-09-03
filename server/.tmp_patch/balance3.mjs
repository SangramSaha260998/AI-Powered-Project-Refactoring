import fs from 'fs';

const file = process.argv[2] || 'src/services/migration.js';
const src = fs.readFileSync(file, 'utf8');

let i = 0;
let line = 1;
const stack = [];

const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);

while (i < src.length) {
  const c = src[i];
  const n = src[i + 1];

  if (c === '\n') { line++; i++; continue; }

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
      if (tc === '{') { tplDepth++; i++; continue; }
      if (tc === '}') { tplDepth--; i++; if (tplDepth === 0) inCode = false; continue; }
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
      if (tc === '`') {
        i++;
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '`') { i++; break; }
          if (src[i] === '\n') line++;
          i++;
        }
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
      i++;
      continue;
    }
    continue;
  }

  if (c === '/' && !isIdPart(n)) {
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

  if (c === '{') {
    const start = Math.max(0, i - 80);
    const snippet = src.slice(start, i + 1).replace(/\s+/g, ' ').slice(-70);
    stack.push({ line, snippet });
  }
  if (c === '}') {
    if (stack.length) stack.pop();
    else console.log(`UNMATCHED } at line ${line}`);
  }
  i++;
}

console.log(`Unclosed braces remaining: ${stack.length}`);
for (const s of stack) {
  console.log(`  at line ${s.line}: ...${s.snippet}`);
}
