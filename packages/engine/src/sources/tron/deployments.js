// SUN mainnet deployments: https://docs.sun.io/protocols/sunswap-v{1,2,3}/reference/contract/
// Multicall3: https://github.com/mds1/multicall3/blob/main/deployments.json
export const MULTICALL = 'TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED'
export const WTRX = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'
export const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
export const QUOTES = [USDT, WTRX, 'TCrEVahRbhDFB6uRXEWUg7wkptXvg47GKs', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8']
export const FACTORIES = [
  { dex: 'sunswap-v2', kind: 'v2', address: 'TKWJdrQkqHisa1X8HUdHEfREvTzw4pMAaY', event: 'PairCreated' },
  { dex: 'sunswap-v3', kind: 'v3', address: 'TThJt8zaJzJMhCEScH7zWKnp5buVZqys9x', event: 'PoolCreated',
    fees: [100, 500, 3000, 10000] },
  { dex: 'sunswap-v1', kind: 'v1', address: 'TXk8rQSAvPvBBNtqSoY6nCfsXWCSSpTVQF' },
  // Same getExchange/token balance/native balance interface (SUN's sunswap-interfaces_en.pdf §2).
  { dex: 'sunswap-v1-5', kind: 'v1', address: 'TB2LM4iegvhPJGWn9qizeefkPMm7bqqaMs' },
]
