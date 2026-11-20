import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
// Load each archived receiver and its workspace imports. Third-party dependencies resolve
// from the surrounding installation. A source-only release/shallow checkout may lack these objects.
export function archive(t, ref) {
  if (spawnSync('git', ['cat-file', '-e', ref + '^{commit}'], { cwd: root }).status !== 0) {
    t.skip('release Git object unavailable: ' + ref)
    return
  }
  const dir = mkdtempSync(join(import.meta.dirname, 'release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packages = ['bundle', 'store', 'social', 'engine', 'net']
  const paths = packages.flatMap(pkg => ['src', 'package.json'].map(p => 'packages/' + pkg + '/' + p))
  const tar = execFileSync('git', ['archive', ref, 'package.json', 'packages/bundle/data', 'packages/net/vendor', ...paths],
    { cwd: root, maxBuffer: 16 << 20 })
  execFileSync('tar', ['-xf', '-', '-C', dir], { input: tar })
  mkdirSync(join(dir, 'node_modules/@gator'), { recursive: true })
  for (const pkg of packages) symlinkSync(join(dir, 'packages', pkg), join(dir, 'node_modules/@gator', pkg), 'junction')
  return (pkg, file = 'index.js') => import(pathToFileURL(join(dir, 'packages', pkg, 'src', file)))
}

export class LocalTransport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  channels() { return [] }
  async join() { return true }
  async leave() { return true }
  send() { return true }
}

