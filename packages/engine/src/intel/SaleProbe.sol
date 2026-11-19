// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}
interface Router {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function WETH9() external view returns (address);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amount, uint256 min, address[] calldata path, address to, uint256 deadline
    ) external;
}
interface Factory {
    function getPair(address, address) external view returns (address);
    function getPool(address, address, uint24) external view returns (address);
}
interface Token {
    function balanceOf(address) external view returns (uint256);
    function deposit() external payable;
}
interface V3 {
    struct Params { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 minimum; }
    function exactInput(Params calldata) external payable returns (uint256);
}
interface V3Router02 {
    struct Params { bytes path; address recipient; uint256 amountIn; uint256 minimum; }
    function exactInput(Params calldata) external payable returns (uint256);
}

/// Runtime injected into an ephemeral address for one read-only eth_call.
/// All nested calls share state and revert to the caller's original state when it ends.
contract SaleProbe {
    function probe(address router, address pool, address token, uint8 kind, uint24 bridgeFee, uint256 amount)
        external returns (uint256 stage, uint256 bought, uint256 proceeds)
    {
        address a = Pair(pool).token0();
        address b = Pair(pool).token1();
        require((a == token || b == token) && a != b);
        address quote = token == a ? b : a;
        Factory factory = Factory(Router(router).factory());
        uint24 fee;
        if (kind == 0) {
            require(factory.getPair(a, b) == pool);
        } else {
            fee = Pair(pool).fee();
            require(factory.getPool(a, b, fee) == pool);
        }
        address wrapped = kind == 0 ? Router(router).WETH() : Router(router).WETH9();
        require(wrapped != token);
        address[] memory path = new address[](quote == wrapped ? 2 : 3);
        path[0] = wrapped;
        path[1] = quote;
        path[path.length - 1] = token;
        Token(wrapped).deposit{value: amount}();
        require(approve(wrapped, router, amount));
        uint256 beforeBuy = Token(token).balanceOf(address(this));
        (bool ok,) = router.call(swapData(path, kind, path.length == 2 ? fee : bridgeFee, fee, amount));
        if (!ok) return (1, 0, 0);
        bought = Token(token).balanceOf(address(this)) - beforeBuy;
        if (bought == 0 || !approve(token, router, bought)) return (2, bought, 0);
        path[0] = token;
        path[path.length - 1] = wrapped;
        uint256 beforeSell = Token(wrapped).balanceOf(address(this));
        bytes memory reason;
        (ok, reason) = router.call(swapData(path, kind, fee, bridgeFee, bought));
        if (!ok) return (reason.length == 0 ? 3 : 4, bought, 0);
        proceeds = Token(wrapped).balanceOf(address(this)) - beforeSell;
        return (5, bought, proceeds);
    }

    function approve(address token, address router, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("approve(address,uint256)", router, amount));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function swapData(address[] memory path, uint8 kind, uint24 firstFee, uint24 secondFee, uint256 amount)
        private view returns (bytes memory)
    {
        if (kind == 0) return abi.encodeCall(Router.swapExactTokensForTokensSupportingFeeOnTransferTokens,
            (amount, 0, path, address(this), block.timestamp));
        bytes memory encoded = abi.encodePacked(path[0], firstFee, path[1]);
        if (path.length == 3) encoded = abi.encodePacked(encoded, secondFee, path[2]);
        if (kind == 1) return abi.encodeCall(V3.exactInput, (V3.Params(encoded, address(this), block.timestamp, amount, 0)));
        return abi.encodeCall(V3Router02.exactInput, (V3Router02.Params(encoded, address(this), amount, 0)));
    }

}
