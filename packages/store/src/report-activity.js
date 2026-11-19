// The network counters use arrival time. Most all-ticker batches arrive in the same second.
// Keep their exact millisecond offsets so the rolling-hour boundary remains exact.
const HOUR = 3_600_000;
const second = at => Math.floor(at / 1000) * 1000;

export function reportActivity({ writer, reader, transaction }) {
  const add = writer.prepare(`INSERT INTO store_report_activity(at,reporter,reports,marks) VALUES (?,?,?,?)
    ON CONFLICT(at,reporter) DO UPDATE SET reports=reports+excluded.reports,
    marks=CAST(marks || excluded.marks AS BLOB)`);
  const seen = writer.prepare(`INSERT INTO store_reporters_seen VALUES (?,?) ON CONFLICT(reporter)
    DO UPDATE SET at=excluded.at WHERE at<excluded.at`);
  function record(reporter, times) {
    const seconds = new Map();
    let last = 0;
    for (const [at, count] of times) {
      last = Math.max(last, at);
      const start = second(at);
      let bucket = seconds.get(start);
      if (!bucket) seconds.set(start, bucket = { reports: 0, marks: [] });
      bucket.reports += count;
      // Split very large synthetic batches. Normal wire batches contain at most 200 rows.
      for (let left = count; left > 0; left -= 65535) {
        const n = Math.min(left, 65535), offset = at - start;
        bucket.marks.push(offset >>> 8, offset & 255, n >>> 8, n & 255);
      }
    }
    for (const [at, bucket] of seconds) add.run(at, reporter, bucket.reports, Buffer.from(bucket.marks));
    seen.run(reporter, last);
  }

  // Each transaction records its cursor. Restarting between batches neither skips nor double-counts receipts.
  const upgrade = writer.prepare('SELECT done,lastId FROM store_activity_upgrade');
  if (upgrade.get()) {
    const now = Date.now();
    const counts = writer.prepare(`SELECT at,reporter,count(*) AS n FROM obs
      WHERE id>? AND id<=? AND at>=? GROUP BY reporter,at`);
    const seedSeen = writer.prepare(`INSERT INTO store_reporters_seen
      SELECT reporter,max(at) FROM obs WHERE id>? AND id<=? AND at>=? GROUP BY reporter
      ON CONFLICT(reporter) DO UPDATE SET at=max(at,excluded.at)`);
    const nextIds = writer.prepare(`SELECT max(id) AS end FROM
      (SELECT id FROM obs WHERE id>? AND id<=? ORDER BY id LIMIT 8192)`);
    const advance = writer.prepare('UPDATE store_activity_upgrade SET done=?');
    while (upgrade.get()) {
      transaction(() => {
        const legacy = upgrade.get();
        if (!legacy) return;
        const end = nextIds.get(legacy.done, legacy.lastId).end ?? legacy.lastId;
        const groups = new Map();
        for (const { at, reporter, n } of counts.iterate(legacy.done, end, now - HOUR)) {
          if (!groups.has(reporter)) groups.set(reporter, new Map());
          groups.get(reporter).set(at, n);
        }
        for (const [reporter, times] of groups) record(reporter, times);
        seedSeen.run(legacy.done, end, now - 24 * HOUR);
        if (end < legacy.lastId) advance.run(end);
        else writer.exec('DELETE FROM store_activity_upgrade');
      });
    }
  }

  const whole = reader.prepare('SELECT coalesce(sum(reports),0) n FROM store_report_activity WHERE reporter=? AND at>=?');
  const edge = reader.prepare('SELECT at,marks,reports FROM store_report_activity WHERE reporter=? AND at>=? AND at<?');
  return {
    record,
    reportsSince(reporter, cutoff) {
      const start = second(cutoff);
      if (start === cutoff) return whole.get(reporter, start).n;
      let count = whole.get(reporter, start + 1000).n;
      for (const { at, marks, reports } of edge.iterate(reporter, start, start + 1000)) {
        // Pre-bucket rows have no offsets. Their reports arrived exactly at the row timestamp.
        let original = reports;
        for (let i = 0; i < marks.length; i += 4) {
          const offset = marks[i] * 256 + marks[i + 1], n = marks[i + 2] * 256 + marks[i + 3];
          original -= n;
          if (at + offset >= cutoff) count += n;
        }
        if (at >= cutoff) count += original;
      }
      return count;
    },
  };
}
