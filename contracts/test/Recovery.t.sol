// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase, TestTap} from "./support/TestBase.sol";
import {PaidExtras} from "../src/PaidExtras.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract RecoveryTest is TestBase {
    function setUp() public override {
        super.setUp();
        vm.prank(BUYER);
        tap.transfer(address(market), 27);
    }

    function testTapRecoveryBetweenPurchasesInSameBlock() public {
        uint256 buyerBalance = tap.balanceOf(BUYER);
        bytes32 first = _book(LAUNCH);
        PaidExtras.Booking memory original = market.purchase(first);
        uint256 nextStart = market.nextStart(LAUNCH);
        assert(tap.balanceOf(address(market)) == 27);

        vm.expectEmit(true, true, false, true, address(market));
        emit PaidExtras.StrayRecovered(tap, OWNER, 19);
        vm.prank(OWNER);
        market.recoverStray(tap, OWNER, 19);

        assert(tap.balanceOf(OWNER) == 19 && tap.balanceOf(address(market)) == 8);
        assert(tap.balanceOf(RECEIVER) == 300 && tap.balanceOf(BUYER) == buyerBalance - 300);
        assert(keccak256(abi.encode(market.purchase(first))) == keccak256(abi.encode(original)));
        _assertSame(market.current(LAUNCH)[0], original.details);
        assert(market.receiver() == RECEIVER && market.price(LAUNCH) == 300 && !market.paused());
        assert(nextStart == CLOCK + 6 hours && market.nextStart(LAUNCH) == nextStart);

        vm.prank(BUYER);
        bytes32 second = market.buy(LAUNCH, HASH, 300, nextStart);
        PaidExtras.Booking memory queued = market.purchase(second);
        assert(queued.slotType == LAUNCH && queued.lane == original.lane && queued.details.buyer == BUYER);
        assert(queued.details.start == nextStart && queued.details.end == nextStart + 6 hours);
        assert(queued.details.price == 300 && queued.details.contentHash == HASH);
        assert(tap.balanceOf(RECEIVER) == 600 && tap.balanceOf(BUYER) == buyerBalance - 600);
        assert(tap.balanceOf(address(market)) == 8);
    }

    function testRecoverOtherERC20() public {
        TestTap otherAsset = new TestTap();
        otherAsset.mint(OTHER, 40);
        vm.prank(OTHER);
        otherAsset.transfer(address(market), 40);
        vm.expectEmit(true, true, false, true, address(market));
        emit PaidExtras.StrayRecovered(otherAsset, OTHER, 40);
        vm.prank(OWNER);
        market.recoverStray(otherAsset, OTHER, 40);
        assert(otherAsset.balanceOf(OTHER) == 40 && otherAsset.balanceOf(address(market)) == 0);
        assert(tap.balanceOf(address(market)) == 27);
    }

    function testOnlyOwnerCanRecover() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BUYER));
        vm.prank(BUYER);
        market.recoverStray(tap, BUYER, 27);
        assert(tap.balanceOf(address(market)) == 27);
    }

    function testRecoveryRejectsZeroRecipient() public {
        vm.expectRevert(PaidExtras.InvalidRecoveryRecipient.selector);
        vm.prank(OWNER);
        market.recoverStray(tap, address(0), 27);
        assert(tap.balanceOf(address(market)) == 27);
    }

    function testRecoveryCanSpendOnlyMarketBalance() public {
        _book(LAUNCH);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(market), 27, 28));
        vm.prank(OWNER);
        market.recoverStray(tap, OWNER, 28);
        assert(tap.balanceOf(address(market)) == 27 && tap.balanceOf(RECEIVER) == 300);
    }
}
