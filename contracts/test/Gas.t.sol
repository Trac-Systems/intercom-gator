// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "./support/TestBase.sol";

contract EmptyMarketGasTest is TestBase {
    function testGasFirstPromotedToken() public {
        _book(PROMO);
    }

    function testGasFirstPinnedNews() public {
        _book(NEWS);
    }

    function testGasFirstLaunchSpotlight() public {
        _book(LAUNCH);
    }
}

contract BookedMarketGasTest is TestBase {
    function setUp() public override {
        super.setUp();
        // Pre-existing state placed in setUp is excluded from each snapshot.
        for (uint8 i; i < 3; ++i) {
            _book(PROMO);
        }
        for (uint8 i; i < 32; ++i) {
            _book(LAUNCH);
        }
    }

    function testGasQueuedPromotedToken() public {
        _book(PROMO);
    }

    function testGasLaunchSpotlightBehind32() public {
        _book(LAUNCH);
    }

    function testGasCurrentThreeActive() public view {
        assert(market.current(PROMO).length == 3);
    }

    function testGasCurrentLaunchSpotlightWith32Bookings() public view {
        assert(market.current(LAUNCH).length == 1);
    }
}
