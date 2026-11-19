// Hyperswarm public keys of the blind relays this release uses when two peers cannot connect directly (not secrets).
// Root network settings (`net.relays`) replace this list at runtime; `gator start --blind-relay` adds local ones.
// gitleaks flags 64-hex strings generically.
export const RELAYS = Object.freeze([
  '0b13c5e546be28a15275c33e0040aba90f3084dfcd172be2af36e0c9eff3a77f', // gitleaks:allow — Trac relay 1
]);
