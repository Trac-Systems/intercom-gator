import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './fixtures.js';
import { httpClient } from '../src/client.js';
import { readToken } from '../src/local.js';
import { main, openBrowser } from '../src/cli.js';

const binary = fileURLToPath(new URL('../../../bin/gator.js',import.meta.url));
const exec = promisify(execFile);

test('executable uses the daemon port and private data directory across CLI and MCP stdio', async t => {
  const app = await fixture(t).start('cli');
  const args = ['--data',app.dataDir];
  const run = async (...words) => (await exec(process.execPath,[binary,...args,...words],{ timeout:10_000 })).stdout.trim();
  assert.match(await run('--help'),/bundle verify/);
  assert.equal(await run('key'),app.transport.publicKey);
  assert.equal(JSON.parse(await run('status')).port,app.port);
  assert.equal(JSON.parse(await run('price','BTC')).id,'bitcoin:native');
  assert.equal(JSON.parse(await run('search','Bitcoin')).tokens[0].symbol,'BTC');
  assert.deepEqual(JSON.parse(await run('feed')).items,[]);
  // `open` hands a one-time ticket to the browser and prints nothing secret (in-process, so no browser starts).
  const launched = [], lines = [];
  await main([...args,'open'],{ launch: async u => { launched.push(u); }, log: line => lines.push(line) });
  assert.equal(launched.length,1);
  const url = new URL(launched[0]);
  assert.equal(url.pathname,'/auth');
  assert.equal(url.origin,'http://127.0.0.1:' + app.port);
  assert.notEqual(url.searchParams.get('t'),readToken(app.dataDir,'dashboard-token'));
  assert.ok(lines.every(line => !line.includes(url.searchParams.get('t')) && !line.includes('/auth')),lines.join('\n'));
  assert.equal((await fetch(url,{ redirect:'manual' })).status,303);
  assert.equal((await fetch(url,{ redirect:'manual' })).status,401); // one use only
  // --print needs an interactive terminal on both stdin and stdout.
  const tty = { isTTY:true }, printed = [];
  for (const io of [{ stdin:tty,stdout:{} },{ stdin:{},stdout:tty }]) {
    await assert.rejects(main([...args,'open','--print'],{ ...io,launch:assert.fail,log:assert.fail }),/interactive terminal/);
  }
  await main([...args,'open','--print'],{ stdin:tty,stdout:tty,launch:assert.fail,log:line => printed.push(line) });
  assert.equal((await fetch(new URL(printed[0]),{ redirect:'manual' })).status,303);
  await assert.rejects(run('open','--print'),e => e.stderr.includes('interactive terminal') && !e.stdout.includes('auth'));
  await assert.rejects(run('post','Refused'),err => err.stderr.includes('agent posting is disabled'));
  const owner = httpClient(app.dataDir,{ owner:true });
  await owner('PUT','/settings',{},{ agent:{ agentPosting:true, agentFollow:true } });
  assert.equal(JSON.parse(await run('post','A','CLI','post')).text,'A CLI post');
  assert.equal(JSON.parse(await run('follow','a'.repeat(64))).followed,true);
  const client = new Client({ name:'cli-test',version:'1' });
  try {
    await client.connect(new StdioClientTransport({ command:process.execPath,args:[binary,...args,'mcp'],stderr:'pipe' }));
    const res = await client.callTool({ name:'price',arguments:{ asset:'BTC' } });
    assert.equal(res.structuredContent.id,'bitcoin:native');
  } finally { await client.close(); }
  let output;
  try { output = await run('doctor'); } catch (error) { output = error.stdout; }
  const diag = JSON.parse(output);
  assert.equal(diag.nodeSupported,true);
  assert.equal(diag.privateDirectory,true);
  assert.equal(diag.listening,true);
  assert.equal(diag.connectivity.peers,0);
  assert.equal(typeof diag.bundle.verified,'boolean');
  // stop uses its own credential: without the owner token it still stops the daemon.
  const ownerFile = join(app.dataDir,'dashboard-token');
  renameSync(ownerFile,ownerFile + '.away');
  assert.deepEqual(JSON.parse(await run('stop')),{ stopping:true });
  renameSync(ownerFile + '.away',ownerFile);
  await app.close();
  assert.equal(existsSync(join(app.dataDir,'daemon.json')),false);
  await assert.rejects(run('--port',String(app.port),'status'),e => e.stderr.includes('Daemon unavailable'));
});

test('foreground shutdown releases the daemon lock and preserves identity on restart', async t => {
  const f = fixture(t), dataDir = join(f.dir,'signals');
  const appUrl = new URL('../src/app.js',import.meta.url).href;
  const code = `import { createGator } from ${JSON.stringify(appUrl)};
    import { MemoryTransport } from '@gator/net';
    const options = JSON.parse(process.argv[1]);
    await createGator({ ...options, port:0, transport:opts => new MemoryTransport(opts),
      fetch:async () => new Response('{}',{ status:503 }) });
    process.send('ready');`;
  const child = spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify({ dataDir,release:f.release })],
    { cwd:fileURLToPath(new URL('../../../',import.meta.url)),stdio:['ignore','ignore','pipe','ipc'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill(); });
  await Promise.race([once(child,'message'),once(child,'exit').then(() => { throw new Error('Daemon exited before ready'); })]);
  const firstKey = JSON.parse(readFileSync(join(dataDir,'daemon.json'))).publicKey;
  await assert.rejects(f.start('signals'),/already in use/);
  const exit = once(child,'exit');
  if (process.platform === 'win32') await exec(process.execPath, [binary, '--data', dataDir, 'stop'], { timeout: 10_000 });
  else child.kill('SIGTERM');
  assert.deepEqual(await exit,[0,null]);
  assert.equal(existsSync(join(dataDir,'daemon.json')),false);
  const next = await f.start('signals');
  assert.equal(next.transport.publicKey,firstKey);
});


test('Windows starts the default browser with a validated loopback ticket and propagates a launcher error', async () => {
  const url = 'http://127.0.0.1:7420/auth?t=' + 'x'.repeat(43);
  let calls = 0, exitCode = 0;
  const launch = (file, args, options) => {
    calls++;
    assert.equal(win32.basename(file), 'cmd.exe');
    assert.ok(win32.isAbsolute(file));
    assert.deepEqual(args, ['/d', '/v:off', '/c', 'start', '""', '"' + url + '"']);
    assert.deepEqual(options, { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', exitCode));
    return child;
  };
  const options = { platform: 'win32', launch };
  await openBrowser(url, options);
  for (const invalid of [url + '&', url + '%', url + '"', url + '\r\n', url.replace('127.0.0.1', 'example.com')]) {
    await assert.rejects(openBrowser(invalid, options), /Invalid browser sign-in URL/);
  }
  exitCode = 1;
  await assert.rejects(openBrowser(url, options), /launch failed/);
  assert.equal(calls, 2);
});
