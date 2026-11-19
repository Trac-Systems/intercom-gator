// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestBase, TestTap} from "./support/TestBase.sol";
import {FeeTap, FalseTap, ShrinkingTap, CallbackTap, NoReturnTap} from "./support/OddTokens.sol";
import {PaidExtras} from "../src/PaidExtras.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

contract PaymentTest is TestBase {
    function _install(TestTap replacement) private {
        tap = replacement;
        market = _deploy(tap);
        _fund(tap, market, BUYER);
    }

    function _assertRolledBack(uint256 receiverBalance) private view {
        assert(tap.balanceOf(BUYER) == type(uint192).max);
        assert(tap.balanceOf(RECEIVER) == receiverBalance && tap.balanceOf(address(market)) == 0);
        assert(market.nextStart(PROMO) == CLOCK && market.current(PROMO).length == 0);
    }

    function testFeeUnderpaymentRollsBackTransferAllowanceAndSlot() public {
        _install(new FeeTap());
        vm.prank(BUYER);
        tap.approve(address(market), 100);
        vm.expectRevert(PaidExtras.IncompletePayment.selector);
        _book(PROMO);
        _assertRolledBack(0);
        assert(tap.allowance(BUYER, address(market)) == 100);
        bytes32 id = keccak256(abi.encode(PROMO, uint8(0), CLOCK + 1 days));
        vm.expectRevert(abi.encodeWithSelector(PaidExtras.UnknownPurchase.selector, id));
        market.purchase(id);
    }

    function testShrinkingReceiverBalanceRollsBack() public {
        _install(new ShrinkingTap());
        tap.mint(RECEIVER, 10);
        vm.expectRevert(PaidExtras.IncompletePayment.selector);
        _book(PROMO);
        _assertRolledBack(10);
    }

    function testFalseReturnRollsBack() public {
        _install(new FalseTap());
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(tap)));
        _book(PROMO);
        _assertRolledBack(0);
    }

    function testNoReturnTokenSettlesExactReceipt() public {
        NoReturnTap odd = new NoReturnTap(BUYER, 100);
        market = _deploy(IERC20(address(odd)));
        vm.prank(BUYER);
        odd.approve(address(market), 100);
        bytes32 id = _book(PROMO);
        assert(market.current(PROMO)[0].id == id);
        assert(odd.balanceOf(RECEIVER) == 100 && odd.balanceOf(BUYER) == 0);
        assert(odd.allowance(BUYER, address(market)) == 0 && odd.balanceOf(address(market)) == 0);
    }

    function testReentrantTokenSeesOnlyPaidSlotsAndCannotEnterBuy() public {
        CallbackTap odd = new CallbackTap();
        _install(odd);
        _book(PROMO);
        assert(odd.visibleDuringCallback() == 0);
        _book(PROMO);
        assert(odd.visibleDuringCallback() == 1);
        assert(odd.callbackError() == ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assert(market.current(PROMO).length == 2 && odd.balanceOf(RECEIVER) == 200);
        assert(odd.balanceOf(address(market)) == 0);
    }

    function testInsufficientAllowanceBubblesUp() public {
        vm.prank(BUYER);
        tap.approve(address(market), 99);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(market), 99, 100)
        );
        _book(PROMO);
        _assertRolledBack(0);
    }

    function testInsufficientBalanceBubblesUp() public {
        vm.prank(OWNER);
        tap.approve(address(market), 100);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, OWNER, 0, 100));
        vm.prank(OWNER);
        market.buy(PROMO, HASH, 100, CLOCK);
        _assertRolledBack(0);
    }

    function testReceiverBuyingForItselfCannotInventPayment() public {
        _fund(tap, market, RECEIVER);
        vm.expectRevert(PaidExtras.IncompletePayment.selector);
        vm.prank(RECEIVER);
        market.buy(PROMO, HASH, 100, CLOCK);
        _assertRolledBack(type(uint192).max);
    }
}
