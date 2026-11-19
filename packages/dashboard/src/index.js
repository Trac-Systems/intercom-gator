import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the static dashboard (index.html, js/, css/, fonts/, vendor/).
 * `packages/api` serves this directory as-is; there is no build step.
 * @type {string}
 */
export const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

/** Entry document inside {@link publicDir}. */
export const indexFile = 'index.html';
