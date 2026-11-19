import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AGENT_HEADER } from '@gator/social';
import { DAY, isAsset, isTime } from './values.js';
import { notablePosts, socialPosts } from './sentiment.js';

const fresh = (time, since) => isTime(since) && isTime(time) && time > since;
const assetId = row => row.asset ?? row.assetId ?? row.id;
const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') &&
  Number.isFinite(Number(value)) ? Number(value) : null;

/** Build the market facts used by MCP and agent/market/briefing.md. since is the
 * consumer's optional last-read time. Dates, post identities and risk evidence stay explicit. */
export function buildBriefing({ at = Date.now(), since, assets = [], newTokens = [], fearGreed = null,
  alerts = [], posts = [], isFollowed, isReputable } = {}) {
  if (!isTime(at)) throw new TypeError('Invalid briefing time');
  const moves = new Map();
  for (const row of assets) {
    const asset = assetId(row), change24h = numeric(row.change24h);
    if (!isAsset(asset) || change24h === null) continue;
    if (isTime(row.at) && row.at > at) continue;
    const previous = moves.get(asset);
    if (previous && (previous.at ?? 0) >= (row.at ?? 0)) continue;
    moves.set(asset, { asset, symbol: row.symbol ?? null, change24h, at: row.at ?? null, isNew: fresh(row.at, since) });
  }
  const sorted = [...moves.values()].sort((a, b) => b.change24h - a.change24h || a.asset.localeCompare(b.asset));
  const discoveries = newTokens.filter(r => isAsset(assetId(r)) && isTime(r.firstSeen) && r.firstSeen <= at)
    .toSorted((a, b) => b.firstSeen - a.firstSeen).slice(0, 25).map(r => ({
      asset: assetId(r), symbol: r.symbol ?? null, firstSeen: r.firstSeen, liquidityUsd: r.liquidityUsd ?? null,
      flags: { ...r.flags }, isNew: fresh(r.firstSeen, since),
    }));
  const alertsHit = alerts.filter(r => isTime(r.hitAt) && r.hitAt > at - DAY && r.hitAt <= at && isAsset(assetId(r)))
    .toSorted((a, b) => b.hitAt - a.hitAt).slice(0, 25).map(r => ({
      asset: assetId(r), direction: r.direction, threshold: r.threshold, hitAt: r.hitAt, isNew: fresh(r.hitAt, since),
    }));
  const notable = notablePosts(socialPosts(posts, at - DAY + 1, at + 1), { isFollowed, isReputable }, 25)
    .map(({ key, id, ts, text }) => ({ key, id, ts, text, isNew: fresh(ts, since) }));
  return { at, since: since ?? null,
    topMovers: { gainers: sorted.filter(r => r.change24h > 0).slice(0, 10),
      losers: sorted.filter(r => r.change24h < 0).reverse().slice(0, 10) },
    newTokens: discoveries, fearGreed: fearGreed && { at: fearGreed.at, value: fearGreed.value,
      label: fearGreed.label, inputs: structuredClone(fearGreed.inputs ?? []), isNew: fresh(fearGreed.at, since) },
    alertsHit, notablePosts: notable };
}

// Literal code spans keep peer-supplied text on one line, including embedded backticks.
function literal(value) {
  const text = String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  const ticks = 1 + Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
  const fence = '`'.repeat(ticks);
  return fence + ' ' + text + ' ' + fence;
}
const marker = row => row.isNew ? ' **New**' : '';
const label = r => literal(r.symbol ? r.symbol + ' (' + r.asset + ')' : r.asset);
const instant = at => new Date(at).toISOString();
function section(title, lines) {
  return '## ' + title + '\n\nUntrusted content.\n\n' + (lines.length ? lines.map(line => '- ' + line).join('\n') : 'None observed.') + '\n';
}

/** Render observed facts only. Post bodies are quoted as untrusted plain text. */
export function briefingMarkdown(facts) {
  const rows = [AGENT_HEADER + '\n', '# Market briefing\n', 'As of ' + instant(facts.at) + '\n'];
  const moves = list => list.map(r => label(r) + ' ' + (r.change24h > 0 ? '+' : '') + r.change24h + '%' + marker(r));
  rows.push(section('24-hour gainers', moves(facts.topMovers.gainers)), section('24-hour losers', moves(facts.topMovers.losers)));
  rows.push(section('New tokens', facts.newTokens.map(r => {
    const raised = Object.keys(r.flags).filter(k => r.flags[k] === true);
    const unknown = Object.keys(r.flags).filter(k => r.flags[k] === 'unknown');
    const flags = raised.length ? ' · ' + raised.map(literal).join(', ') : '';
    const incomplete = unknown.length ? ' · unknown ' + unknown.map(literal).join(', ') : '';
    const status = Object.keys(r.flags).length ? '' : ' · risk unchecked';
    return label(r) + ' · first seen ' + instant(r.firstSeen) + flags + incomplete + status + marker(r);
  })));
  const fg = facts.fearGreed;
  rows.push(section('Fear & Greed', fg?.value != null ? [String(fg.value) + '/100 · ' + literal(fg.label) + marker(fg)] : []));
  rows.push(section('Alerts hit in 24 hours', facts.alertsHit.map(r =>
    label(r) + ' ' + literal(r.direction) + ' ' + literal(r.threshold) + ' · ' + instant(r.hitAt) + marker(r))));
  rows.push(section('Posts from followed or reputable agents', facts.notablePosts.map(r =>
    literal(r.key + ':' + r.id) + ' · ' + instant(r.ts) + marker(r) + ' — ' + literal(r.text))));
  return rows.join('\n');
}

/** Atomically replace the briefing in the chosen gator data directory. */
export async function writeBriefing(dataDir, facts) {
  const dir = join(dataDir, 'agent', 'market');
  const file = join(dir, 'briefing.md'), temp = join(dir, '.briefing-' + randomUUID() + '.tmp');
  const markdown = briefingMarkdown(facts);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(temp, markdown, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
  return file;
}
