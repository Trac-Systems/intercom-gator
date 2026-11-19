// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "./support/TestBase.sol";
import {PaidExtras, SlotType} from "../src/PaidExtras.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SchedulingTest is TestBase {
    function testPurchaseEventAndReadback() public {
        bytes32 id = keccak256(abi.encode(PROMO, uint8(0), CLOCK + 1 days));
        vm.expectEmit(true, true, false, true, address(tap));
        emit IERC20.Transfer(BUYER, RECEIVER, 100);
        vm.expectEmit(true, true, true, true, address(market));
        emit PaidExtras.Purchased(id, PROMO, 0, BUYER, HASH, CLOCK, CLOCK + 1 days, 100);
        vm.prank(BUYER);
        assert(market.buy(PROMO, HASH, 100, CLOCK) == id);
        PaidExtras.Booking memory booking = market.purchase(id);
        PaidExtras.Purchase memory saved = booking.details;
        assert(saved.id == id && booking.slotType == PROMO && booking.lane == 0);
        assert(saved.buyer == BUYER && saved.contentHash == HASH && saved.price == 100);
        assert(saved.start == CLOCK && saved.end == CLOCK + 24 hours);
        _assertSame(market.current(PROMO)[0], saved);
        assert(tap.balanceOf(RECEIVER) == 100 && tap.balanceOf(address(market)) == 0);
    }

    function testPriceSlippageThenExactLimits() public {
        uint256 quote = market.price(LAUNCH);
        vm.prank(OWNER);
        market.setPrice(LAUNCH, quote + 1);
        vm.expectRevert(abi.encodeWithSelector(PaidExtras.PriceAboveLimit.selector, quote + 1, quote));
        vm.prank(BUYER);
        market.buy(LAUNCH, HASH, quote, CLOCK);
        assert(market.current(LAUNCH).length == 0 && tap.balanceOf(RECEIVER) == 0);
        vm.prank(BUYER);
        market.buy(LAUNCH, HASH, quote + 1, CLOCK);
    }

    function testStartSlippageThenExactLimits() public {
        _book(LAUNCH);
        uint256 start = CLOCK + 6 hours;
        vm.expectRevert(abi.encodeWithSelector(PaidExtras.StartAfterLimit.selector, start, start - 1));
        vm.prank(OTHER);
        market.buy(LAUNCH, HASH, 300, start - 1);
        assert(market.nextStart(LAUNCH) == start && tap.balanceOf(RECEIVER) == 300);
        vm.prank(OTHER);
        bytes32 id = market.buy(LAUNCH, HASH, 300, start);
        assert(market.purchase(id).details.buyer == OTHER && market.purchase(id).details.start == start);
    }

    function testRejectsEmptyHashAndUnknownId() public {
        vm.expectRevert(PaidExtras.EmptyContentHash.selector);
        vm.prank(BUYER);
        market.buy(NEWS, bytes32(0), 200, CLOCK);
        vm.expectRevert(abi.encodeWithSelector(PaidExtras.UnknownPurchase.selector, HASH));
        market.purchase(HASH);
    }

    function testRejectsOutOfRangeSlotTypeAtAbiBoundary() public {
        (bool ok,) = address(market).call(abi.encodeWithSelector(PaidExtras.buy.selector, uint8(3), HASH, 100, CLOCK));
        assert(!ok && tap.balanceOf(RECEIVER) == 0);
        bytes4[5] memory reads = [
            PaidExtras.capacity.selector,
            PaidExtras.duration.selector,
            PaidExtras.current.selector,
            PaidExtras.nextStart.selector,
            bytes4(keccak256("price(uint8)"))
        ];
        for (uint256 i; i < reads.length; ++i) {
            (ok,) = address(market).staticcall(abi.encodeWithSelector(reads[i], uint8(3)));
            assert(!ok);
        }
        vm.prank(OWNER);
        (ok,) = address(market).call(abi.encodeWithSelector(PaidExtras.setPrice.selector, uint8(3), 1));
        assert(!ok);
    }

    function testEndMustFitTimestampStorage() public {
        vm.warp(type(uint64).max);
        uint256 end = uint256(type(uint64).max) + 6 hours;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 64, end));
        _book(LAUNCH);
    }

    function testFutureQueueHalfOpenBoundariesAndHistory() public {
        bytes32[7] memory ids;
        for (uint8 i; i < ids.length; ++i) {
            ids[i] = _book(PROMO);
            assert(market.purchase(ids[i]).lane == i % 3);
        }
        for (uint8 day; day < 3; ++day) {
            uint256 start = CLOCK + uint256(day) * 1 days;
            vm.warp(start);
            PaidExtras.Purchase[] memory active = market.current(PROMO);
            assert(active.length == (day == 2 ? 1 : 3));
            for (uint8 lane; lane < active.length; ++lane) {
                assert(active[lane].id == ids[day * 3 + lane]);
                assert(active[lane].start == start && active[lane].end == start + 1 days);
            }
            vm.warp(start + 1 days - 1);
            assert(market.current(PROMO)[0].id == ids[day * 3]);
        }
        vm.warp(CLOCK + 9 days);
        assert(market.current(PROMO).length == 0);
        assert(market.nextStart(PROMO) == CLOCK + 9 days);
        bytes32 fresh = _book(PROMO);
        // Lanes 1 and 2 expired first. Lane 1 wins their tie even though all are idle.
        assert(market.purchase(fresh).lane == 1);
        assert(market.current(PROMO)[0].id == fresh);
        assert(market.purchase(ids[0]).details.end == CLOCK + 1 days);
    }

    function testStaggeredLanesCanExpireIndependently() public {
        bytes32 first = _book(NEWS);
        vm.warp(CLOCK + 1 hours);
        bytes32 second = _book(NEWS);
        vm.warp(CLOCK + 12 hours);
        assert(market.current(NEWS).length == 1 && market.current(NEWS)[0].id == second);
        bytes32 third = _book(NEWS);
        assert(
            market.purchase(third).lane == 0
                && market.purchase(third).details.start == market.purchase(first).details.end
        );
        assert(market.current(NEWS).length == 2 && market.current(LAUNCH).length == 0);
    }
}
