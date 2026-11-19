const HOUR = 3_600_000;

/** Local evidence only. A reporter is a distinct signing identity seen by this node. */
export function coverageReader(engine) {
  const { reader } = engine.store;
  const related = `WITH related(id) AS (SELECT market FROM asset_markets WHERE asset=$asset
    UNION SELECT id FROM markets WHERE quote=$asset) `;
  const activity = reader.prepare(related + `SELECT count(DISTINCT o.reporter) AS day,
    count(DISTINCT CASE WHEN o.srcTs>=$hour THEN o.reporter END) AS hour,
    count(CASE WHEN o.reporter=$own THEN 1 END) AS localSamples,
    max(CASE WHEN o.reporter=$own THEN o.srcTs END) AS localAt,
    max(CASE WHEN o.reporter<>$own THEN o.srcTs END) AS peerAt,
    count(DISTINCT m.exchange) AS observedVenues
    FROM related a JOIN markets m ON m.id=a.id CROSS JOIN obs o ON o.market=m.id
    WHERE o.srcTs BETWEEN $day AND $now`);
  const latest = reader.prepare(related + `SELECT max((SELECT max(srcTs) FROM obs WHERE market=a.id AND srcTs<=$now)) AS at
    FROM related a`);
  const markets = reader.prepare(related + `SELECT m.exchange AS venue,count(*) AS markets,
    sum(m.kind='dex') AS pools FROM related a JOIN markets m ON m.id=a.id GROUP BY m.exchange ORDER BY m.exchange`);
  const poolList = reader.prepare(related + `SELECT m.id AS market,m.exchange AS venue FROM related a
    JOIN markets m ON m.id=a.id WHERE m.kind='dex' ORDER BY m.id LIMIT 50`);
  const history = reader.prepare('SELECT min(ts) AS first,max(ts) AS last,count(*) AS bars FROM candles WHERE asset=?');
  const logo = reader.prepare('SELECT l.sha FROM engine_logos l JOIN engine_logo_images i USING(sha) WHERE l.ref=? AND l.url=?');
  return function coverage(asset) {
    const now = engine.clock(), own = engine.transport.publicKey;
    const token = engine.registry.assets.get(asset);
    const { day, hour, localSamples, localAt, peerAt, observedVenues } =
      activity.get({ asset, own, hour: now - HOUR, day: now - 24 * HOUR, now });
    const lastAt = latest.get({ now, asset }).at, venues = markets.all({ asset });
    const { first, last, bars } = history.get(asset);
    const nameResolved = engine.names.display(asset)?.nameStatus === 'resolved';
    const ref = 'asset:' + asset, source = engine.logos.resolve(ref);
    const hasLogo = !!(source && logo.get(ref, source));
    const family = engine.registry.chains.get(asset.split(':', 1)[0])?.family;
    const pools = venues.reduce((sum, v) => sum + v.pools, 0);
    const totalKnown = token?.totalSupply != null, circulatingKnown = token?.supply != null;
    const poolDiscovery = !asset.endsWith(':native') && (engine.evm.has(asset.split(':', 1)[0]) || family === 'solana');
    const adds = ['Increase local scheduling priority for matching markets'];
    if (!bars || last - first < 7 * 24 * HOUR) adds.push('Import missing hourly bars from supported venues');
    if (!nameResolved) adds.push('Resolve token metadata');
    if (!hasLogo && source) adds.push('Fetch the signed logo reference');
    if (!totalKnown) adds.push('Check supply where a reader is available');
    if (poolDiscovery) adds.push('Discover verified pools through the public token seeder');
    return { asset, registered: !!token, asOf: now, reporters: { lastHour: hour, lastDay: day },
      local: { observations24h: localSamples, lastAt24h: localAt }, peers: { lastAt24h: peerAt,
        reporters1h: hour - Number(localAt !== null && localAt >= now - HOUR), reporters24h: day - Number(localAt !== null) },
      venues, observedVenues24h: observedVenues, pools, poolsSeen: pools ? poolList.all({ asset }) : [],
      freshness: { lastAt, ageMs: lastAt == null ? null : now - lastAt },
      history: { firstAt: first, lastAt: last, bars, depthHours: bars ? (last - first) / HOUR : 0 },
      supplyKnown: totalKnown || circulatingKnown, totalSupplyKnown: totalKnown, circulatingSupplyKnown: circulatingKnown,
      nameResolved, logo: hasLogo, whatFocusWouldAdd: adds };
  };
}
