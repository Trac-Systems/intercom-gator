const GiB = 1024 ** 3;

// v0.1.4 (owner 11-20): storage tenfold on every profile (large 10 GiB), so nodes keep chart history for many more
// tokens. v0.1.0-v0.1.3 used 150/400/1024 MiB and 100/500/2000 kept assets. The app never lets the store take more
// than half of the disk space that is still free.
export const PROFILE_LIMITS = Object.freeze({
  small: Object.freeze({ storeBudgetMB: 1500, keptAssets: 1000, requestsPerMinute: 60 }),
  normal: Object.freeze({ storeBudgetMB: 4000, keptAssets: 5000, requestsPerMinute: 240 }),
  large: Object.freeze({ storeBudgetMB: 10240, keptAssets: 20000, requestsPerMinute: 900 }),
});

/** Storage caps that earlier releases saved as the profile default (first start writes the default to config.json). */
export const PREVIOUS_STORE_DEFAULTS_MB = Object.freeze({
  small: Object.freeze([150, 250]), normal: Object.freeze([400, 1024]), large: Object.freeze([1024, 4096]),
});

/** @param {{totalMemBytes: number, cpus: number, freeDiskBytes: number}} resources */
export function detectProfile({ totalMemBytes, cpus, freeDiskBytes }) {
  for (const value of [totalMemBytes, cpus, freeDiskBytes]) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid machine capacity');
  }
  if (!Number.isInteger(cpus) || cpus < 1) throw new RangeError('Expected a positive CPU count');

  let profile = 'small';
  if (totalMemBytes >= 16 * GiB && cpus >= 8 && freeDiskBytes >= 8 * GiB) profile = 'large';
  else if (totalMemBytes >= 4 * GiB && cpus >= 2 && freeDiskBytes >= 2 * GiB) profile = 'normal';
  return { profile, limits: PROFILE_LIMITS[profile] };
}

export function limitsFor(profile) {
  if (!Object.hasOwn(PROFILE_LIMITS, profile)) throw new RangeError('Unknown store profile');
  return PROFILE_LIMITS[profile];
}
