/** Wait for best-effort work at most `ms`. Shutdown uses it for reads that ignore the abort signal and for channel
 * leaves (a DHT unannounce can take seconds; the transport is closed right after anyway). */
export async function settleWithin(promises, ms = 2000) {
  let timer
  await Promise.race([
    Promise.allSettled(promises),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
}
