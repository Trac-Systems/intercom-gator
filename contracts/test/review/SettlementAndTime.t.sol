// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "../support/TestBase.sol";
import {PaidExtras} from "../../src/PaidExtras.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract SettlementAndTimeReviewTest is TestBase {
    function testPurchasePreservesOpeningMarketBalance() public {
        tap.mint(address(market), 7);
        uint256 buyerBalance = tap.balanceOf(BUYER);
        uint256 payeeBalance = tap.balanceOf(RECEIVER);
        vm.prank(BUYER);
        bytes32 id = market.buy(NEWS, HASH, 200, CLOCK);
        assert(market.purchase(id).details.price == 200);
        assert(tap.balanceOf(BUYER) == buyerBalance - 200);
        assert(tap.balanceOf(RECEIVER) == payeeBalance + 200);
        assert(tap.balanceOf(address(market)) == 7);
    }

    function testLastRepresentableEndAndNextQuote() public {
        uint256 lastEnd = type(uint64).max;
        uint256 start = lastEnd - 6 hours;
        vm.warp(start);
        vm.prank(BUYER);
        bytes32 id = market.buy(LAUNCH, HASH, 300, type(uint256).max);
        PaidExtras.Purchase memory active = market.current(LAUNCH)[0];
        assert(active.id == id && active.start == start && active.end == lastEnd);
        assert(market.nextStart(LAUNCH) == lastEnd);

        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, lastEnd + 6 hours));
        _book(LAUNCH);
        assert(tap.balanceOf(RECEIVER) == 300);
        vm.warp(lastEnd - 1);
        assert(market.current(LAUNCH)[0].id == id);
        vm.warp(lastEnd);
        assert(market.current(LAUNCH).length == 0);
        assert(market.purchase(id).details.end == lastEnd);
    }
}
