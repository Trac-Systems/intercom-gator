const GiB = 1024 ** 3;

export const PROFILE_LIMITS = Object.freeze({
  small: Object.freeze({ storeBudgetMB: 150, keptAssets: 100, requestsPerMinute: 60 }),
  normal: Object.freeze({ storeBudgetMB: 400, keptAssets: 500, requestsPerMinute: 240 }),
  large: Object.freeze({ storeBudgetMB: 1024, keptAssets: 2000, requestsPerMinute: 900 }),
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
