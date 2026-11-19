/** Return the exact nonnegative fixed-point string supplied by the source. */
export function decimal(value, name = 'price') {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/u.test(value) || !Number.isFinite(Number(value))) {
    throw new TypeError(name + ' must be a finite, nonnegative decimal string');
  }
  return value;
}

/** Compare validated decimal strings without converting their significands to doubles. */
export function compareDecimal(a, b) {
  if (a === b) return 0;
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const left = ai.replace(/^0+/u, '');
  const right = bi.replace(/^0+/u, '');
  if (left.length !== right.length) return left.length - right.length;
  if (left !== right) return left < right ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const x = af.padEnd(width, '0');
  const y = bf.padEnd(width, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

export function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name + ' must be a nonnegative safe integer');
  return value;
}

export function page({ limit = 100, offset = 0 } = {}) {
  return [integer(limit, 'limit'), integer(offset, 'offset')];
}

/** JSON columns store JSON null distinctly from a missing row. */
export function encode(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Expected a JSON value');
  return json;
}

export function decoded(row, ...fields) {
  if (!row) return row;
  for (const key of fields) if (row[key] !== null) row[key] = JSON.parse(row[key]);
  return row;
}

export function timeRange({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  return [integer(from, 'from'), integer(to, 'to')];
}
