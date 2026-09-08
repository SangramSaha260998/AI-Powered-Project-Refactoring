import assert from 'node:assert/strict';
import { hasUnitWriterMarkers, stripUnitWriterMarkers } from '../src/utils/llmOutput.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repairUnitWriterMarkerPollution } from '../src/services/postprocess.js';

const leaked = `===== FILE: src/components/TaskDeleteDialog.tsx =====
import React from 'react';

export function TaskDeleteDialog() {
  return <div>Delete?</div>;
}
===== END =====
`;

assert.equal(hasUnitWriterMarkers(leaked), true);
const cleaned = stripUnitWriterMarkers(leaked);
assert.equal(hasUnitWriterMarkers(cleaned), false);
assert.match(cleaned, /export function TaskDeleteDialog/);
assert.doesNotMatch(cleaned, /===== FILE:/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-output-'));
const componentDir = path.join(tmp, 'src', 'components');
fs.mkdirSync(componentDir, { recursive: true });
fs.writeFileSync(path.join(componentDir, 'TaskDeleteDialog.tsx'), leaked, 'utf-8');
assert.equal(repairUnitWriterMarkerPollution(tmp), 1);
const onDisk = fs.readFileSync(path.join(componentDir, 'TaskDeleteDialog.tsx'), 'utf-8');
assert.equal(hasUnitWriterMarkers(onDisk), false);

console.log('PASS: llmOutput marker stripping');
