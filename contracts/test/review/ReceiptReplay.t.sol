// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "../support/TestBase.sol";
import {PaidExtras} from "../../src/PaidExtras.sol";

interface ReceiptRecorder {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ReceiptReplayReviewTest is TestBase {
    bytes32 private constant PURCHASED =
        keccak256("Purchased(bytes32,uint8,uint8,address,bytes32,uint256,uint256,uint256)");

    function testPinnedNewsReplayMatchesViewThroughHandoffAndExpiry() public {
        ReceiptRecorder recorder = ReceiptRecorder(address(vm));
        recorder.recordLogs();
        _book(NEWS);
        _book(PROMO);
        vm.warp(CLOCK + 1 hours);
        vm.prank(OTHER);
        market.buy(NEWS, keccak256("second post"), 200, CLOCK + 1 hours);
        vm.prank(OWNER);
        market.setPrice(NEWS, 150);
        vm.prank(OTHER);
        market.buy(NEWS, keccak256("queued post"), 150, CLOCK + 12 hours);
        vm.prank(OWNER);
        market.setPaused(true);

        ReceiptRecorder.Log[] memory logs = recorder.getRecordedLogs();
        _checkNewsReplay(logs, CLOCK + 1 hours, 2);
        _checkNewsReplay(logs, CLOCK + 12 hours - 1, 2);
        _checkNewsReplay(logs, CLOCK + 12 hours, 2);
        _checkNewsReplay(logs, CLOCK + 13 hours, 1);
        _checkNewsReplay(logs, CLOCK + 24 hours, 0);
    }

    function _checkNewsReplay(ReceiptRecorder.Log[] memory logs, uint256 time, uint256 expectedCount) private {
        vm.warp(time);
        PaidExtras.Purchase[2] memory byLane;
        for (uint256 i; i < logs.length; ++i) {
            ReceiptRecorder.Log memory entry = logs[i];
            if (entry.emitter != address(market) || entry.topics[0] != PURCHASED) continue;
            assert(entry.topics.length == 4);
            if (uint256(entry.topics[2]) != uint8(NEWS)) continue;
            (uint8 lane, bytes32 content, uint256 start, uint256 end, uint256 price) =
                abi.decode(entry.data, (uint8, bytes32, uint256, uint256, uint256));
            if (start <= time && time < end) {
                assert(byLane[lane].buyer == address(0));
                address buyer = address(uint160(uint256(entry.topics[3])));
                byLane[lane] = PaidExtras.Purchase(entry.topics[1], buyer, content, start, end, price);
            }
        }

        PaidExtras.Purchase[] memory current = market.current(NEWS);
        assert(current.length == expectedCount);
        uint256 matched;
        for (uint256 lane; lane < byLane.length; ++lane) {
            if (byLane[lane].buyer != address(0)) {
                _assertSame(byLane[lane], current[matched++]);
            }
        }
        assert(matched == expectedCount);
    }
}
