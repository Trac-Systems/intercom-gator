// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

enum SlotType {
    PromotedToken,
    PinnedNews,
    LaunchSpotlight
}

/// @notice Fixed-duration paid placements. Harnesses display active content as "Promoted".
contract PaidExtras is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Purchase {
        bytes32 id;
        address buyer;
        bytes32 contentHash;
        uint256 start;
        uint256 end;
        uint256 price;
    }

    struct Booking {
        Purchase details;
        SlotType slotType;
        uint8 lane;
    }

    // The first four fields fit in one storage word. Start follows from the fixed duration.
    struct Record {
        address buyer;
        uint64 end;
        SlotType slotType;
        uint8 lane;
        bytes32 contentHash;
        uint256 price;
    }

    IERC20 public immutable token;
    address public receiver;
    bool public paused;
    mapping(SlotType => uint256) public price;
    mapping(SlotType => uint64[3]) private _busyUntil;
    mapping(bytes32 => Record) private _records;

    error InvalidToken();
    error InvalidReceiver();
    error InvalidRecoveryRecipient();
    error ZeroPrice();
    error PurchasesPaused();
    error EmptyContentHash();
    error PriceAboveLimit(uint256 actual, uint256 limit);
    error StartAfterLimit(uint256 actual, uint256 limit);
    error IncompletePayment();
    error UnknownPurchase(bytes32 id);
    error RenunciationDisabled();

    event ReceiverChanged(address indexed previousReceiver, address indexed newReceiver);
    event PriceChanged(SlotType indexed slotType, uint256 previousPrice, uint256 newPrice);
    event PauseChanged(bool paused);
    event StrayRecovered(IERC20 indexed asset, address indexed to, uint256 amount);
    event Purchased(
        bytes32 indexed id,
        SlotType indexed slotType,
        uint8 lane,
        address indexed buyer,
        bytes32 contentHash,
        uint256 start,
        uint256 end,
        uint256 price
    );

    /// @param initialPrices TAP base units in SlotType enum order.
    constructor(IERC20 paymentToken, address initialOwner, address initialReceiver, uint256[3] memory initialPrices)
        Ownable(initialOwner)
    {
        if (address(paymentToken).code.length == 0) revert InvalidToken();
        token = paymentToken;
        _setReceiver(initialReceiver);
        for (uint8 i; i < 3; ++i) {
            _setPrice(SlotType(i), initialPrices[i]);
        }
    }

    function capacity(SlotType slotType) public pure returns (uint8) {
        if (slotType == SlotType.PromotedToken) return 3;
        if (slotType == SlotType.PinnedNews) return 2;
        return 1;
    }

    function duration(SlotType slotType) public pure returns (uint256) {
        if (slotType == SlotType.PromotedToken) return 24 hours;
        if (slotType == SlotType.PinnedNews) return 12 hours;
        return 6 hours;
    }

    /// @notice The buyer must have approved this contract for at least the current price.
    function buy(SlotType slotType, bytes32 contentHash, uint256 maxPrice, uint256 maxStart)
        external
        nonReentrant
        returns (bytes32 id)
    {
        if (paused) revert PurchasesPaused();
        if (contentHash == bytes32(0)) revert EmptyContentHash();
        uint256 amount = price[slotType];
        if (amount > maxPrice) revert PriceAboveLimit(amount, maxPrice);
        (uint8 lane, uint256 start) = _nextLane(slotType);
        if (start > maxStart) revert StartAfterLimit(start, maxStart);
        uint64 end = SafeCast.toUint64(start + duration(slotType));
        id = _id(slotType, lane, end);

        // During token callbacks all views still describe fully paid purchases.
        _collectPayment(msg.sender, receiver, amount);
        _records[id] = Record(msg.sender, end, slotType, lane, contentHash, amount);
        _busyUntil[slotType][lane] = end;
        emit Purchased(id, slotType, lane, msg.sender, contentHash, start, end, amount);
    }

    function nextStart(SlotType slotType) external view returns (uint256 start) {
        (, start) = _nextLane(slotType);
    }

    /// @notice Returns exactly the active [start, end) intervals, in lane order.
    function current(SlotType slotType) external view returns (Purchase[] memory active) {
        bytes32[3] memory ids;
        uint256 count;
        uint8 lanes = capacity(slotType);
        uint256 interval = duration(slotType);
        for (uint8 lane; lane < lanes; ++lane) {
            uint256 tail = _busyUntil[slotType][lane];
            if (tail > block.timestamp) {
                // Future bookings in this lane abut. Step back whole intervals from its tail.
                uint256 laterIntervals = (tail - block.timestamp - 1) / interval;
                ids[count++] = _id(slotType, lane, tail - laterIntervals * interval);
            }
        }
        active = new Purchase[](count);
        for (uint256 i; i < count; ++i) {
            active[i] = purchase(ids[i]).details;
        }
    }

    function purchase(bytes32 id) public view returns (Booking memory) {
        Record storage record = _records[id];
        if (record.buyer == address(0)) revert UnknownPurchase(id);
        Purchase memory details = Purchase(
            id, record.buyer, record.contentHash, record.end - duration(record.slotType), record.end, record.price
        );
        return Booking(details, record.slotType, record.lane);
    }

    function setReceiver(address newReceiver) external onlyOwner {
        _setReceiver(newReceiver);
    }

    function setPrice(SlotType slotType, uint256 newPrice) external onlyOwner {
        _setPrice(slotType, newPrice);
    }

    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PauseChanged(newPaused);
    }

    /// @notice Returns stray ERC-20s held by this contract. Buyers pay the receiver directly.
    function recoverStray(IERC20 asset, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidRecoveryRecipient();
        asset.safeTransfer(to, amount);
        emit StrayRecovered(asset, to, amount);
    }

    function renounceOwnership() public pure override {
        revert RenunciationDisabled();
    }

    function _nextLane(SlotType slotType) private view returns (uint8 lane, uint256 start) {
        uint64[3] storage ends = _busyUntil[slotType];
        start = ends[0];
        uint8 lanes = capacity(slotType);
        for (uint8 i = 1; i < lanes; ++i) {
            if (ends[i] < start) {
                start = ends[i];
                lane = i;
            }
        }
        if (start < block.timestamp) start = block.timestamp;
    }

    function _id(SlotType slotType, uint8 lane, uint256 end) private pure returns (bytes32) {
        return keccak256(abi.encode(slotType, lane, end));
    }

    function _collectPayment(address buyer, address payee, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(payee);
        token.safeTransferFrom(buyer, payee, amount);
        uint256 afterBalance = token.balanceOf(payee);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance < amount) revert IncompletePayment();
    }

    function _setReceiver(address newReceiver) private {
        if (newReceiver == address(0) || newReceiver == address(this) || newReceiver == address(token)) {
            revert InvalidReceiver();
        }
        emit ReceiverChanged(receiver, newReceiver);
        receiver = newReceiver;
    }

    function _setPrice(SlotType slotType, uint256 newPrice) private {
        if (newPrice == 0) revert ZeroPrice();
        emit PriceChanged(slotType, price[slotType], newPrice);
        price[slotType] = newPrice;
    }
}
