// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase, TestTap} from "./support/TestBase.sol";
import {PaidExtras, SlotType} from "../src/PaidExtras.sol";

contract FuzzTest is TestBase {
    function testFuzzQueueAtArbitraryOffset(uint8 rawKind, uint8 rawCount, uint32 rawOffset) public {
        SlotType kind = SlotType(rawKind % 3);
        uint256 count = 1 + uint256(rawCount % 24);
        uint256 lanes = 3 - uint256(uint8(kind));
        uint256 interval = uint256(24 hours) >> uint8(kind);
        bytes32[] memory ids = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _book(kind);
            PaidExtras.Booking memory booking = market.purchase(ids[i]);
            PaidExtras.Purchase memory p = booking.details;
            assert(booking.lane == i % lanes && p.start == CLOCK + i / lanes * interval);
            assert(p.end == p.start + interval);
        }
        uint256 offset = rawOffset % ((count / lanes + 2) * interval);
        vm.warp(CLOCK + offset);
        uint256 first = (offset / interval) * lanes;
        uint256 expected = first >= count ? 0 : count - first;
        if (expected > lanes) expected = lanes;
        PaidExtras.Purchase[] memory active = market.current(kind);
        assert(active.length == expected);
        for (uint256 i; i < expected; ++i) {
            assert(active[i].id == ids[first + i]);
        }
        uint256 wait = count / lanes * interval;
        assert(market.nextStart(kind) == CLOCK + (wait > offset ? wait : offset));
    }

    function testFuzzPriceLimitAndReceipt(uint8 rawKind, uint256 amount, uint256 limit) public {
        SlotType kind = SlotType(rawKind % 3);
        if (amount == 0) amount = 1;
        tap = new TestTap();
        market = _deploy(tap);
        tap.mint(BUYER, amount);
        vm.prank(BUYER);
        tap.approve(address(market), amount);
        vm.prank(OWNER);
        market.setPrice(kind, amount);
        if (limit < amount) {
            vm.expectRevert(abi.encodeWithSelector(PaidExtras.PriceAboveLimit.selector, amount, limit));
        }
        vm.prank(BUYER);
        market.buy(kind, HASH, limit, CLOCK);
        uint256 paid = limit < amount ? 0 : amount;
        assert(tap.balanceOf(RECEIVER) == paid && tap.balanceOf(BUYER) == amount - paid);
        assert(market.current(kind).length == (paid == 0 ? 0 : 1));
        assert(tap.balanceOf(address(market)) == 0);
    }

    function testFuzzStartLimitAtDifferentArrivalTimes(uint8 rawKind, uint32 rawDelay, uint32 rawLimit) public {
        SlotType kind = SlotType(rawKind % 3);
        uint256 lanes = 3 - uint256(uint8(kind));
        uint256 interval = uint256(24 hours) >> uint8(kind);
        for (uint256 i; i < lanes; ++i) {
            _book(kind);
        }
        uint256 arrival = CLOCK + rawDelay % (2 * interval);
        vm.warp(arrival);
        uint256 expected = arrival > CLOCK + interval ? arrival : CLOCK + interval;
        uint256 limit = CLOCK + rawLimit % (2 * interval);
        assert(market.nextStart(kind) == expected);
        if (limit < expected) {
            vm.expectRevert(abi.encodeWithSelector(PaidExtras.StartAfterLimit.selector, expected, limit));
            vm.prank(OTHER);
            market.buy(kind, HASH, type(uint256).max, limit);
            assert(market.nextStart(kind) == expected);
        } else {
            vm.prank(OTHER);
            bytes32 id = market.buy(kind, HASH, type(uint256).max, limit);
            assert(market.purchase(id).details.start == expected && market.purchase(id).lane == 0);
        }
    }
}
