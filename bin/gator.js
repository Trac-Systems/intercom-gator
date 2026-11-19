#!/usr/bin/env node
import { main } from '../packages/api/src/cli.js';

main(process.argv.slice(2)).catch(error => {
  process.stderr.write('gator: ' + error.message + '\n');
  process.exitCode = 1;
});
