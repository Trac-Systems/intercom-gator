// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PaidExtras} from "../src/PaidExtras.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface SepoliaBroadcast {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function addr(uint256 key) external pure returns (address);
    function startBroadcast(uint256 key) external;
    function stopBroadcast() external;
}

/// @dev The sepolia RPC alias in foundry.toml resolves SEPOLIA_RPC_URL from the environment.
/// Run via 'forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url sepolia --broadcast'.
contract DeploySepolia {
    SepoliaBroadcast private constant vm = SepoliaBroadcast(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (PaidExtras extras) {
        require(block.chainid == 11155111, "expected Sepolia chain 11155111");
        uint256 key = vm.envUint("SEPOLIA_PRIVATE_KEY");
        address owner = vm.addr(key);
        IERC20 tap = IERC20(vm.envAddress("SEPOLIA_TAP"));
        address receiver = vm.envAddress("SEPOLIA_RECEIVER");
        uint256[3] memory prices = [
            vm.envUint("SEPOLIA_PROMOTED_TOKEN_PRICE"),
            vm.envUint("SEPOLIA_PINNED_NEWS_PRICE"),
            vm.envUint("SEPOLIA_LAUNCH_SPOTLIGHT_PRICE")
        ];
        vm.startBroadcast(key);
        extras = new PaidExtras(tap, owner, receiver, prices);
        vm.stopBroadcast();
    }
}
