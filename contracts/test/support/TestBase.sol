// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PaidExtras, SlotType} from "../../src/PaidExtras.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface VmTest {
    function warp(uint256 timestamp) external;
    function getBlockTimestamp() external view returns (uint256);
    function prank(address sender) external;
    function expectRevert(bytes4 reason) external;
    function expectRevert(bytes calldata reason) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

contract TestTap is ERC20 {
    constructor() ERC20("Test TAP", "TAP") {}

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }
}

abstract contract TestAccounts {
    VmTest internal constant vm = VmTest(address(uint160(uint256(keccak256("hevm cheat code")))));
    // Public addresses of Anvil's default accounts 0 through 4.
    address internal constant OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant RECEIVER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant BUYER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant OTHER = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant SECOND_RECEIVER = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    uint256 internal constant CLOCK = 1_800_000_000;
    bytes32 internal constant HASH = keccak256("signed post fixture");
    SlotType internal constant PROMO = SlotType.PromotedToken;
    SlotType internal constant NEWS = SlotType.PinnedNews;
    SlotType internal constant LAUNCH = SlotType.LaunchSpotlight;
}

abstract contract TestBase is TestAccounts {
    TestTap internal tap;
    PaidExtras internal market;

    function setUp() public virtual {
        vm.warp(CLOCK);
        tap = new TestTap();
        market = _deploy(tap);
        _fund(tap, market, BUYER);
        _fund(tap, market, OTHER);
    }

    function _prices() internal pure returns (uint256[3] memory) {
        return [uint256(100), 200, 300];
    }

    function _deploy(IERC20 token) internal returns (PaidExtras) {
        return new PaidExtras(token, OWNER, RECEIVER, _prices());
    }

    function _fund(TestTap token, PaidExtras target, address buyer) internal {
        token.mint(buyer, type(uint192).max);
        vm.prank(buyer);
        token.approve(address(target), type(uint256).max);
    }

    function _book(SlotType kind) internal returns (bytes32) {
        vm.prank(BUYER);
        return market.buy(kind, HASH, type(uint256).max, type(uint256).max);
    }

    function _assertSame(PaidExtras.Purchase memory a, PaidExtras.Purchase memory b) internal pure {
        assert(keccak256(abi.encode(a)) == keccak256(abi.encode(b)));
    }
}
