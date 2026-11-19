# Shipped patch feed snapshot

Before a release, copy the root-signed feed export `patches/<release digest>.json` from the public repo here, under
the same name. For every release so far that is `2e7fd025868071e3a31a8dc5f6b8041f7e9a359dbacffc00bb43db39e721a7bb.json`.
At startup the node applies it through the same checks as a feed receipt, and only when it reaches beyond the stored
chain. Without the file the node waits for the feed as before. See DESIGN.md §5.4 "Bundle patch feed".
