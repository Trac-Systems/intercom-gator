#!/bin/sh
# Run from the repository root with local Anvil already listening.
set -eu
port=${ANVIL_PORT:-8545}
case "$port" in
    ''|*[!0-9]*) exit 2 ;;
esac
exec forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "http://127.0.0.1:$port" --unlocked \
    --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast --slow
