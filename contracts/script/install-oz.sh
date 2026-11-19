#!/bin/sh
# Run from the repository root. The three upstream test-only submodules are unnecessary.
set -eu
GIT_CONFIG_COUNT=3 \
GIT_CONFIG_KEY_0=submodule.lib/forge-std.active GIT_CONFIG_VALUE_0=false \
GIT_CONFIG_KEY_1=submodule.lib/erc4626-tests.active GIT_CONFIG_VALUE_1=false \
GIT_CONFIG_KEY_2=submodule.lib/halmos-cheatcodes.active GIT_CONFIG_VALUE_2=false \
forge install --no-git --shallow OpenZeppelin/openzeppelin-contracts@tag=v5.7.0
