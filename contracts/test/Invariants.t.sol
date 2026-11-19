// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase, TestAccounts, TestTap} from "./support/TestBase.sol";
import {PaidExtras, SlotType} from "../src/PaidExtras.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MarketHandler is TestAccounts {
    PaidExtras private immutable market;
    TestTap private immutable tap;
    PaidExtras.Booking[] private history;

    uint256[3] private expectedPrices = [uint256(100), 200, 300];
    address private expectedReceiver = RECEIVER;
    bool private expectedPaused;
    uint256 private expectedStray;
    mapping(address => uint256) private receipts;

    constructor(PaidExtras target, TestTap token) {
        market = target;
        tap = token;
    }

    function buy(uint8 rawKind, bool secondBuyer) external {
        SlotType kind = SlotType(rawKind % 3);
        address buyer = secondBuyer ? OTHER : BUYER;
        bytes32 content = bytes32(history.length + 1);
        if (expectedPaused) {
            vm.expectRevert(PaidExtras.PurchasesPaused.selector);
            vm.prank(buyer);
            market.buy(kind, content, type(uint256).max, type(uint256).max);
            return;
        }
        (uint8 lane, uint256 start) = _expectedNext(kind);
        uint256 amount = expectedPrices[uint8(kind)];
        vm.prank(buyer);
        bytes32 id = market.buy(kind, content, amount, start);
        uint256 interval = uint256(24 hours) >> uint8(kind);
        PaidExtras.Purchase memory details = PaidExtras.Purchase(id, buyer, content, start, start + interval, amount);
        history.push(PaidExtras.Booking(details, kind, lane));
        receipts[expectedReceiver] += amount;
    }

    function advance(uint32 secondsForward) external {
        vm.warp(block.timestamp + secondsForward % (30 hours + 1));
    }

    function sendStrayTap(uint96 amount) external {
        vm.prank(BUYER);
        tap.transfer(address(market), amount);
        expectedStray += amount;
    }

    function recoverStrayTap(bool authorized, uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) % (expectedStray + 1);
        _asAdmin(authorized);
        market.recoverStray(tap, BUYER, amount);
        if (authorized) expectedStray -= amount;
    }

    function changePrice(bool authorized, uint8 rawKind, uint96 rawPrice) external {
        SlotType kind = SlotType(rawKind % 3);
        uint256 newPrice = uint256(rawPrice) + 1;
        _asAdmin(authorized);
        market.setPrice(kind, newPrice);
        if (authorized) expectedPrices[uint8(kind)] = newPrice;
    }

    function changeReceiver(bool authorized, bool second) external {
        address recipient = second ? SECOND_RECEIVER : RECEIVER;
        _asAdmin(authorized);
        market.setReceiver(recipient);
        if (authorized) expectedReceiver = recipient;
    }

    function changePause(bool authorized, bool newPaused) external {
        _asAdmin(authorized);
        market.setPaused(newPaused);
        if (authorized) expectedPaused = newPaused;
    }

    function _asAdmin(bool authorized) private {
        if (!authorized) {
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        }
        vm.prank(authorized ? OWNER : OTHER);
    }

    function checkPaymentsAndSettings() external view {
        // Only direct transfers and recoveries change this balance. Purchases preserve it.
        assert(tap.balanceOf(address(market)) == expectedStray);
        assert(tap.balanceOf(RECEIVER) == receipts[RECEIVER]);
        assert(tap.balanceOf(SECOND_RECEIVER) == receipts[SECOND_RECEIVER]);
        assert(market.owner() == OWNER && market.receiver() == expectedReceiver);
        assert(market.paused() == expectedPaused);
        for (uint8 i; i < 3; ++i) {
            assert(market.price(SlotType(i)) == expectedPrices[i]);
        }
    }

    function checkAllIntervals() external view {
        // Check every interval, including already expired and far-future bookings.
        // One non-overlapping history per legal lane implies the total capacity bound.
        uint256[3][3] memory lastEnd;
        bytes32[3][3] memory activeIds;
        for (uint256 i; i < history.length; ++i) {
            PaidExtras.Booking memory booking = history[i];
            PaidExtras.Purchase memory p = booking.details;
            uint8 kind = uint8(booking.slotType);
            assert(booking.lane < 3 - kind && p.start >= lastEnd[kind][booking.lane]);
            lastEnd[kind][booking.lane] = p.end;
            assert(keccak256(abi.encode(market.purchase(p.id))) == keccak256(abi.encode(booking)));
            if (p.start <= block.timestamp && block.timestamp < p.end) {
                assert(activeIds[kind][booking.lane] == bytes32(0));
                activeIds[kind][booking.lane] = p.id;
            }
        }
        for (uint8 kind; kind < 3; ++kind) {
            PaidExtras.Purchase[] memory active = market.current(SlotType(kind));
            uint256 count;
            for (uint8 lane; lane < 3 - kind; ++lane) {
                bytes32 id = activeIds[kind][lane];
                if (id != bytes32(0)) {
                    assert(active[count].id == id);
                    assert(keccak256(abi.encode(active[count])) == keccak256(abi.encode(market.purchase(id).details)));
                    ++count;
                }
            }
            assert(active.length == count);
            (, uint256 next) = _expectedNext(SlotType(kind));
            assert(market.nextStart(SlotType(kind)) == next);
        }
    }

    // Reconstruct availability from the independent purchase ledger on every query.
    function _expectedNext(SlotType kind) private view returns (uint8 lane, uint256 start) {
        uint256[3] memory ends;
        for (uint256 i; i < history.length; ++i) {
            PaidExtras.Booking storage booking = history[i];
            if (booking.slotType == kind && booking.details.end > ends[booking.lane]) {
                ends[booking.lane] = booking.details.end;
            }
        }
        for (uint8 i = 1; i < 3 - uint8(kind); ++i) {
            if (ends[i] < ends[lane]) lane = i;
        }
        start = ends[lane] > block.timestamp ? ends[lane] : block.timestamp;
    }
}

contract MarketInvariantTest is TestBase {
    MarketHandler private handler;

    function setUp() public override {
        super.setUp();
        handler = new MarketHandler(market, tap);
        handler.sendStrayTap(7);
        // Seed an active and a queued booking before random pauses or price changes.
        handler.buy(uint8(LAUNCH), false);
        handler.buy(uint8(LAUNCH), true);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_PurchasesPreserveMarketBalanceAndPayConfiguredReceiver() public view {
        handler.checkPaymentsAndSettings();
    }

    function invariant_HistoricalPricesCapacityAndActiveIncludingWhilePaused() public view {
        handler.checkAllIntervals();
    }
}
