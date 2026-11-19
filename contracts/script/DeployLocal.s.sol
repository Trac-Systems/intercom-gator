// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PaidExtras} from "../src/PaidExtras.sol";

interface LocalBroadcast {
    function startBroadcast(address sender) external;
    function stopBroadcast() external;
}

contract AnvilTap is ERC20 {
    constructor(address buyer) ERC20("Anvil test TAP", "TAP") {
        _mint(buyer, 1_000 ether);
    }
}

contract DeployLocal {
    LocalBroadcast private constant vm = LocalBroadcast(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address private constant RECEIVER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address private constant BUYER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    function run() external returns (AnvilTap tap, PaidExtras extras) {
        require(block.chainid == 31337, "expected local Anvil chain 31337");
        vm.startBroadcast(OWNER);
        tap = new AnvilTap(BUYER);
        extras = new PaidExtras(tap, OWNER, RECEIVER, [uint256(1 ether), 2 ether, 3 ether]);
        vm.stopBroadcast();
    }
}
