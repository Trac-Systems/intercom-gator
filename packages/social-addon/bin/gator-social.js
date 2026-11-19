#!/usr/bin/env node
import { main } from '../src/cli.js';

const exit = () => setTimeout(() => process.exit(), 2000).unref();
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write('gator-social: ' + (error?.message ?? error) + '\n');
  process.exitCode = 1;
}
exit();
