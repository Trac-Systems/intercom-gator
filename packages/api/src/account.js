import { randomUUID } from 'node:crypto';
import { addressKind } from '../../dashboard/public/js/lib/text.js';
import { check } from './local.js';

export const migrations = [{ id: 'api-001', up(db) {
  db.exec(`CREATE TABLE api_move_alerts (
    id INTEGER PRIMARY KEY, asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    threshold TEXT NOT NULL, createdAt INTEGER NOT NULL, hitAt INTEGER
  ) STRICT;
  CREATE INDEX api_move_alerts_asset ON api_move_alerts(asset,hitAt);
  CREATE TABLE api_addresses (id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL,
    label TEXT NOT NULL, UNIQUE(chain,address)) STRICT;`);
} }];

function decimalInput(input, error) {
  const value = String(input);
  check(value.length <= 100 && Number(value) > 0 && Number.isFinite(Number(value)), error);
  // Inputs from HTML number fields can arrive in scientific notation.
  const [, whole, fraction = '', exp = 0] = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value) ?? [];
  check(whole, error);
  const digits = whole + fraction, point = whole.length + Number(exp);
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return digits.slice(0, point) + '.' + digits.slice(point);
}

export function createAccount(store, clock, emit) {
  const { reader, writer } = store;
  const moves = reader.prepare("SELECT 'move-'||id AS id, asset,'move' AS direction,threshold,createdAt,hitAt FROM api_move_alerts");
  const pending = reader.prepare(`SELECT id,direction,threshold FROM alerts WHERE asset=? AND hitAt IS NULL
    UNION ALL SELECT 'move-'||id, 'move',threshold FROM api_move_alerts WHERE asset=? AND hitAt IS NULL`);
  function listAlerts() { return [...store.listAlerts(), ...moves.all()].sort((a, b) => b.createdAt - a.createdAt); }
  function alerts() {
    return { items: listAlerts().map(a => {
      const token = store.getAsset(a.asset);
      return { id: String(a.id), asset: a.asset, symbol: token.symbol, value: +a.threshold, op: a.direction,
        hit: a.hitAt, created: a.createdAt, price: token.price == null ? null : +token.price };
    }) };
  }
  /** Alerts are one-shot. They fire only on a green price (R-APP-01), so a price that few reporters confirm can neither
   * trigger an alert nor use it up before the real move. Non-green prices leave every alert pending. */
  function onPrice(p) {
    if (p.trust !== 'green') return;
    for (const a of pending.all(p.asset, p.asset)) {
      const hit = a.direction === 'move' ? p.change1h != null && Math.abs(p.change1h) >= +a.threshold
        : p.price != null && (a.direction === 'above' ? p.price > +a.threshold : p.price < +a.threshold);
      if (!hit) continue;
      const n = a.direction === 'move'
        ? writer.prepare('UPDATE api_move_alerts SET hitAt=? WHERE id=? AND hitAt IS NULL').run(clock(), a.id.slice(5)).changes
        : store.hitAlert(a.id, clock());
      if (n) emit('alert', { id: String(a.id), asset: p.asset, text: p.asset + ' ' + a.direction + ' ' + a.threshold, trust: p.trust });
    }
  }
  function editAlert(b) {
    if (b.remove) {
      const id = String(b.id);
      if (/^move-\d+$/.test(id)) writer.prepare('DELETE FROM api_move_alerts WHERE id=?').run(id.slice(5));
      else if (/^\d+$/.test(id)) store.removeAlert(id);
    } else {
      check(typeof b.asset === 'string' && store.getAsset(b.asset) && ['move','above','below'].includes(b.op), 'bad alert');
      const threshold = decimalInput(b.value, 'bad alert');
      if (b.op === 'move') writer.prepare('INSERT INTO api_move_alerts(asset,threshold,createdAt) VALUES(?,?,?)').run(b.asset, threshold, clock());
      else store.addAlert({ asset: b.asset, direction: b.op, threshold, createdAt: clock() });
    }
    return alerts();
  }

  function portfolio() {
    const holdings = store.listPortfolio().map(h => {
      const t = store.getAsset(h.asset);
      const amount = +h.amount, price = t.price == null ? null : +t.price;
      return { ...h, source: h.account ? 'address' : 'manual', name: t.name, symbol: t.symbol, amount, price,
        trust: t.trust, change24h: t.change24h, value: price == null ? null : amount * price };
    });
    const value = holdings.reduce((sum, h) => sum + (h.value ?? 0), 0);
    const comparable = holdings.filter(h => h.value != null && h.change24h != null && h.change24h > -100);
    const prior = comparable.reduce((sum, h) => sum + h.value / (1 + h.change24h / 100), 0);
    const change24h = prior ? (comparable.reduce((s, h) => s + h.value, 0) / prior - 1) * 100 : null;
    const addresses = reader.prepare('SELECT *,NULL AS value FROM api_addresses ORDER BY rowid').all();
    return { value, holdings, addresses, change24h };
  }
  function editPortfolio(b) {
    if (b.op === 'add-holding' || b.op === 'remove-holding') {
      check(typeof b.asset === 'string' && store.getAsset(b.asset), 'bad holding');
      store.setHolding({ asset: b.asset, amount: b.op === 'remove-holding' ? '0' : decimalInput(b.amount, 'bad holding') });
    } else if (b.op === 'add-address') {
      const kind = addressKind(b.address);
      check(kind, 'not an address');
      const chain = String(b.chain || { evm: 'Ethereum', sol: 'Solana', btc: 'Bitcoin' }[kind]).slice(0, 100);
      writer.prepare(`INSERT INTO api_addresses VALUES(?,?,?,?) ON CONFLICT(chain,address)
        DO UPDATE SET label=excluded.label`).run(randomUUID(), chain, b.address.trim(), String(b.label || '').slice(0,40));
    } else if (b.op === 'remove-address') writer.prepare('DELETE FROM api_addresses WHERE id=?').run(String(b.id));
    else check(false, 'bad op');
    return portfolio();
  }
  return { listAlerts, alerts, editAlert, onPrice, portfolio, editPortfolio };
}
