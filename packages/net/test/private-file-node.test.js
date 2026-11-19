import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsNodeProblem } from '../src/private-file.js';

test('native Windows refuses Node.js older than 22.17 with a clear message; other platforms are unaffected', () => {
  assert.match(windowsNodeProblem('22.16.0', 'win32'), /needs Node\.js 22\.17 or newer \(this is 22\.16\.0\)/);
  assert.match(windowsNodeProblem('22.13.0', 'win32'), /use WSL/);
  for (const v of ['22.17.0', '22.23.4', '24.1.0']) assert.equal(windowsNodeProblem(v, 'win32'), null);
  assert.equal(windowsNodeProblem('22.13.0', 'linux'), null);
  assert.equal(windowsNodeProblem('22.13.0', 'darwin'), null);
});
