// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestTap} from "./TestBase.sol";
import {PaidExtras, SlotType} from "../../src/PaidExtras.sol";

contract FeeTap is TestTap {
    // Burn one base unit of each transfer from a funded account.
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount != 0) {
            super._update(from, address(0), 1);
            --amount;
        }
        super._update(from, to, amount);
    }
}

contract FalseTap is TestTap {
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

contract ShrinkingTap is TestTap {
    function transferFrom(address, address to, uint256) public override returns (bool) {
        _burn(to, 1);
        return true;
    }
}

contract CallbackTap is TestTap {
    bytes4 public callbackError;
    uint256 public visibleDuringCallback;

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        PaidExtras market = PaidExtras(msg.sender);
        visibleDuringCallback = market.current(SlotType.PromotedToken).length;
        // This empty request cannot buy anything. The selector establishes that the
        // nested call hits the guard before it can enter the purchase body.
        try market.buy(SlotType.PromotedToken, bytes32(0), 0, 0) returns (bytes32) {
            revert("unexpected callback success");
        } catch (bytes memory reason) {
            callbackError = bytes4(reason);
        }
        return super.transferFrom(from, to, amount);
    }
}

// The transferFrom selector matches ERC-20 but returns no data.
contract NoReturnTap {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address buyer, uint256 amount) {
        balanceOf[buyer] = amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
