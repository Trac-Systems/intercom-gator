import { observationAccessors } from './observations.js';
import { openDatabase } from './database.js';
import { candleAccessors } from './candles.js';
import { marketAccessors } from './markets.js';
import { pruneAccessors } from './prune.js';
import { recordAccessors } from './records.js';
import { migrations } from './schema.js';
export { detectProfile, PROFILE_LIMITS } from './profile.js';

/** @param {{file: string, profile?: string, migrations?: import('./database.js').Migration[]}} options */
export function openStore(options) {
  const db = openDatabase(options, migrations);
  try {
    return { ...db, ...marketAccessors(db), ...recordAccessors(db), ...candleAccessors(db), ...observationAccessors(db), ...pruneAccessors(db) };
  } catch (error) {
    db.close();
    throw error;
  }
}
