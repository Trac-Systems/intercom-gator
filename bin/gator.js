#!/usr/bin/env node
import { main } from '../packages/api/src/cli.js';
import { windowsNodeProblem } from '../packages/net/src/private-file.js';

const problem = windowsNodeProblem();
if (problem) {
  process.stderr.write('gator: ' + problem + '\n');
  process.exitCode = 1;
} else main(process.argv.slice(2)).catch(error => {
  process.stderr.write('gator: ' + error.message + '\n');
  process.exitCode = 1;
});
