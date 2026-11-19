// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase} from "./support/TestBase.sol";
import {PaidExtras, SlotType} from "../src/PaidExtras.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

contract SettingsTest is TestBase {
    function testInitialStateAndTerms() public view {
        assert(address(market.token()) == address(tap));
        assert(market.owner() == OWNER && market.pendingOwner() == address(0));
        assert(market.receiver() == RECEIVER && !market.paused());
        uint8[3] memory caps = [uint8(3), 2, 1];
        uint256[3] memory durations = [uint256(24 hours), 12 hours, 6 hours];
        for (uint8 i; i < 3; ++i) {
            SlotType kind = SlotType(i);
            assert(market.capacity(kind) == caps[i] && market.duration(kind) == durations[i]);
            assert(market.price(kind) == _prices()[i]);
            assert(market.current(kind).length == 0 && market.nextStart(kind) == CLOCK);
        }
    }

    function testRejectsInvalidConstructorInputs() public {
        uint256[3] memory prices = _prices();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PaidExtras(tap, address(0), RECEIVER, prices);
        vm.expectRevert(PaidExtras.InvalidToken.selector);
        new PaidExtras(IERC20(address(0)), OWNER, RECEIVER, prices);
        vm.expectRevert(PaidExtras.InvalidToken.selector);
        new PaidExtras(IERC20(BUYER), OWNER, RECEIVER, prices);
        vm.expectRevert(PaidExtras.InvalidReceiver.selector);
        new PaidExtras(tap, OWNER, address(0), prices);
        vm.expectRevert(PaidExtras.InvalidReceiver.selector);
        new PaidExtras(tap, OWNER, address(tap), prices);
        for (uint8 i; i < 3; ++i) {
            prices = _prices();
            prices[i] = 0;
            vm.expectRevert(PaidExtras.ZeroPrice.selector);
            new PaidExtras(tap, OWNER, RECEIVER, prices);
        }
    }

    function testOwnerCannotSetInvalidReceiverOrZeroPrice() public {
        vm.expectRevert(PaidExtras.InvalidReceiver.selector);
        vm.prank(OWNER);
        market.setReceiver(address(0));
        vm.expectRevert(PaidExtras.InvalidReceiver.selector);
        vm.prank(OWNER);
        market.setReceiver(address(market));
        vm.expectRevert(PaidExtras.InvalidReceiver.selector);
        vm.prank(OWNER);
        market.setReceiver(address(tap));
        vm.expectRevert(PaidExtras.ZeroPrice.selector);
        vm.prank(OWNER);
        market.setPrice(NEWS, 0);
        assert(market.receiver() == RECEIVER && market.price(NEWS) == 200);
    }

    function testSettingsEmitAndOnlyAffectLaterPayments() public {
        bytes32 first = _book(NEWS);
        vm.expectEmit(true, true, false, true, address(market));
        emit PaidExtras.ReceiverChanged(RECEIVER, SECOND_RECEIVER);
        vm.prank(OWNER);
        market.setReceiver(SECOND_RECEIVER);
        vm.expectEmit(true, false, false, true, address(market));
        emit PaidExtras.PriceChanged(NEWS, 200, 73);
        vm.prank(OWNER);
        market.setPrice(NEWS, 73);
        bytes32 second = _book(NEWS);
        assert(market.purchase(first).details.price == 200 && market.purchase(second).details.price == 73);
        assert(tap.balanceOf(RECEIVER) == 200 && tap.balanceOf(SECOND_RECEIVER) == 73);
        assert(tap.balanceOf(address(market)) == 0 && market.price(PROMO) == 100);
    }

    function testPausePreservesActiveAndQueuedAndUnpauseResumes() public {
        bytes32 first = _book(LAUNCH);
        bytes32 second = _book(LAUNCH);
        vm.expectEmit(false, false, false, true, address(market));
        emit PaidExtras.PauseChanged(true);
        vm.prank(OWNER);
        market.setPaused(true);
        assert(market.paused() && market.current(LAUNCH)[0].id == first);
        assert(market.nextStart(LAUNCH) == CLOCK + 12 hours);
        for (uint8 i; i < 3; ++i) {
            vm.expectRevert(PaidExtras.PurchasesPaused.selector);
            _book(SlotType(i));
        }
        vm.warp(CLOCK + 6 hours);
        assert(market.current(LAUNCH)[0].id == second);
        vm.expectEmit(false, false, false, true, address(market));
        emit PaidExtras.PauseChanged(false);
        vm.prank(OWNER);
        market.setPaused(false);
        assert(market.purchase(_book(LAUNCH)).details.start == CLOCK + 12 hours);
    }

    function _denied(address who) private {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
        vm.prank(who);
    }

    function testOnlyOwnerCanChangeSettings() public {
        _denied(BUYER);
        market.setReceiver(SECOND_RECEIVER);
        _denied(BUYER);
        market.setPrice(PROMO, 1);
        _denied(BUYER);
        market.setPaused(true);
        _denied(BUYER);
        market.transferOwnership(BUYER);
    }

    function testTwoStepHandoverAndCancellation() public {
        vm.expectEmit(true, true, false, true, address(market));
        emit Ownable2Step.OwnershipTransferStarted(OWNER, OTHER);
        vm.prank(OWNER);
        market.transferOwnership(OTHER);
        assert(market.owner() == OWNER && market.pendingOwner() == OTHER);
        _denied(OTHER);
        market.setPrice(PROMO, 1);
        _denied(BUYER);
        market.acceptOwnership();
        vm.prank(OWNER);
        market.transferOwnership(address(0));
        _denied(OTHER);
        market.acceptOwnership();
        vm.prank(OWNER);
        market.transferOwnership(OTHER);
        vm.expectEmit(true, true, false, true, address(market));
        emit Ownable.OwnershipTransferred(OWNER, OTHER);
        vm.prank(OTHER);
        market.acceptOwnership();
        assert(market.owner() == OTHER && market.pendingOwner() == address(0));
        _denied(OWNER);
        market.setPaused(true);
        vm.prank(OTHER);
        market.setPaused(true);
        assert(market.paused());
    }

    function testOwnershipCannotBeRenounced() public {
        vm.expectRevert(PaidExtras.RenunciationDisabled.selector);
        vm.prank(OWNER);
        market.renounceOwnership();
        assert(market.owner() == OWNER);
    }
}
