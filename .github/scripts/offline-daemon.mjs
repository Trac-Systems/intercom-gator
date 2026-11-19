// Preloaded only in the smoke daemon. Exercise the real native swarm and storage
// on an isolated DHT, with no public bootstrap or market-data calls.
import dht from 'hyperdht/lib/constants.js';

dht.BOOTSTRAP_NODES.length = 0;
dht.KNOWN_NODES.length = 0;
globalThis.fetch = async () => new Response(null, { status: 503 });
