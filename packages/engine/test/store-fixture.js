import { existsSync } from 'node:fs'

// Parallel development checkouts contain different workspace packages before integration.
export function workspaceModule(name) {
  const local = new URL('../../' + name + '/src/index.js', import.meta.url)
  return existsSync(local)
    ? local.href
    : new URL('../../../../intercom-gator-wt-' + name + '/packages/' + name + '/src/index.js', import.meta.url).href
}
export const { openStore } = await import(process.env.GATOR_TEST_STORE_MODULE ?? workspaceModule('store'))
