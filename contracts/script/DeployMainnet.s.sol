// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PaidExtras} from "../src/PaidExtras.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface MainnetBroadcast {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function addr(uint256 key) external pure returns (address);
    function startBroadcast(uint256 key) external;
    function stopBroadcast() external;
}

/// @dev The owner key is the root-derived secp256k1 key (DESIGN.md §3); it deploys and owns the contract.
/// The mainnet RPC alias in foundry.toml resolves MAINNET_RPC_URL from the environment.
/// Run via 'forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url mainnet --broadcast'.
contract DeployMainnet {
    MainnetBroadcast private constant vm = MainnetBroadcast(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant TAP = 0x5e7F6e008C6d9D7AD4c7EB75Bd4ce62864cc7454;

    function run() external returns (PaidExtras extras) {
        require(block.chainid == 1, "expected Ethereum mainnet");
        uint256 key = vm.envUint("GATOR_ETH_OWNER_KEY");
        address owner = vm.addr(key);
        address receiver = vm.envAddress("MAINNET_RECEIVER");
        uint256[3] memory prices = [
            vm.envUint("MAINNET_PROMOTED_TOKEN_PRICE"),
            vm.envUint("MAINNET_PINNED_NEWS_PRICE"),
            vm.envUint("MAINNET_LAUNCH_SPOTLIGHT_PRICE")
        ];
        vm.startBroadcast(key);
        extras = new PaidExtras(IERC20(TAP), owner, receiver, prices);
        vm.stopBroadcast();
    }
}
