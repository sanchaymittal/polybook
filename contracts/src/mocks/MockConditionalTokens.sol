// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";

/**
 * @title MockConditionalTokens
 * @notice Mock implementation of Gnosis CTF for testing.
 * @dev Simplified version that tracks conditions, positions, and payouts.
 */
contract MockConditionalTokens is ERC1155, IConditionalTokens {
    // ============ State ============

    /// @notice Payout numerators by condition ID
    mapping(bytes32 => uint256[]) private _payoutNumerators;

    /// @notice Payout denominator by condition ID
    mapping(bytes32 => uint256) private _payoutDenominator;

    // ============ Constructor ============

    constructor() ERC1155("") {}

    // ============ IConditionalTokens Implementation ============

    function prepareCondition(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) external override {
        require(outcomeSlotCount <= 256, "too many outcome slots");
        require(outcomeSlotCount > 1, "there should be more than one outcome slot");

        bytes32 conditionId = getConditionId(oracle, questionId, outcomeSlotCount);
        require(_payoutNumerators[conditionId].length == 0, "condition already prepared");

        _payoutNumerators[conditionId] = new uint256[](outcomeSlotCount);

        emit ConditionPreparation(conditionId, oracle, questionId, outcomeSlotCount);
    }

    function reportPayouts(
        bytes32 questionId,
        uint256[] calldata payouts
    ) external override {
        uint256 outcomeSlotCount = payouts.length;
        bytes32 conditionId = getConditionId(msg.sender, questionId, outcomeSlotCount);

        require(_payoutNumerators[conditionId].length == outcomeSlotCount, "condition not prepared");
        require(_payoutDenominator[conditionId] == 0, "payout already set");

        uint256 den = 0;
        for (uint256 i = 0; i < outcomeSlotCount; i++) {
            _payoutNumerators[conditionId][i] = payouts[i];
            den += payouts[i];
        }
        require(den > 0, "payout is all zeroes");
        _payoutDenominator[conditionId] = den;

        emit ConditionResolution(conditionId, msg.sender, questionId, outcomeSlotCount, payouts);
    }

    function splitPosition(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        require(partition.length > 1, "got empty or singleton partition");
        require(_payoutNumerators[conditionId].length > 0, "condition not prepared");

        // Transfer collateral from sender (only for root splits)
        if (parentCollectionId == bytes32(0)) {
            require(
                collateralToken.transferFrom(msg.sender, address(this), amount),
                "could not receive collateral"
            );
        }

        // Mint position tokens
        for (uint256 i = 0; i < partition.length; i++) {
            bytes32 collectionId = getCollectionId(parentCollectionId, conditionId, partition[i]);
            uint256 positionId = getPositionId(collateralToken, collectionId);
            _mint(msg.sender, positionId, amount, "");
        }

        emit PositionSplit(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function mergePositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        require(partition.length > 1, "got empty or singleton partition");

        // Burn position tokens
        for (uint256 i = 0; i < partition.length; i++) {
            bytes32 collectionId = getCollectionId(parentCollectionId, conditionId, partition[i]);
            uint256 positionId = getPositionId(collateralToken, collectionId);
            _burn(msg.sender, positionId, amount);
        }

        // Transfer collateral back (only for root merges)
        if (parentCollectionId == bytes32(0)) {
            require(
                collateralToken.transfer(msg.sender, amount),
                "could not send collateral"
            );
        }

        emit PositionsMerge(msg.sender, collateralToken, parentCollectionId, conditionId, partition, amount);
    }

    function redeemPositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external override {
        uint256 den = _payoutDenominator[conditionId];
        require(den > 0, "result for condition not received yet");

        uint256 outcomeSlotCount = _payoutNumerators[conditionId].length;
        uint256 totalPayout = 0;

        for (uint256 i = 0; i < indexSets.length; i++) {
            uint256 indexSet = indexSets[i];
            bytes32 collectionId = getCollectionId(parentCollectionId, conditionId, indexSet);
            uint256 positionId = getPositionId(collateralToken, collectionId);

            // Calculate payout numerator for this index set
            uint256 payoutNumerator = 0;
            for (uint256 j = 0; j < outcomeSlotCount; j++) {
                if (indexSet & (1 << j) != 0) {
                    payoutNumerator += _payoutNumerators[conditionId][j];
                }
            }

            uint256 payoutStake = balanceOf(msg.sender, positionId);
            if (payoutStake > 0) {
                totalPayout += (payoutStake * payoutNumerator) / den;
                _burn(msg.sender, positionId, payoutStake);
            }
        }

        if (totalPayout > 0) {
            if (parentCollectionId == bytes32(0)) {
                require(
                    collateralToken.transfer(msg.sender, totalPayout),
                    "could not transfer payout"
                );
            }
        }

        emit PayoutRedemption(msg.sender, collateralToken, parentCollectionId, conditionId, indexSets, totalPayout);
    }

    // ============ View Functions ============

    function payoutNumerators(bytes32 conditionId) external view override returns (uint256[] memory) {
        return _payoutNumerators[conditionId];
    }

    function payoutDenominator(bytes32 conditionId) external view override returns (uint256) {
        return _payoutDenominator[conditionId];
    }

    function getOutcomeSlotCount(bytes32 conditionId) external view override returns (uint256) {
        return _payoutNumerators[conditionId].length;
    }

    /// @dev Override to satisfy both ERC1155 and IConditionalTokens
    function balanceOf(address account, uint256 id) public view override(ERC1155, IConditionalTokens) returns (uint256) {
        return super.balanceOf(account, id);
    }

    // ============ Helper Functions ============

    function getConditionId(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) public pure override returns (bytes32) {
        return keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount));
    }

    function getCollectionId(
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) public pure override returns (bytes32) {
        return keccak256(abi.encodePacked(parentCollectionId, conditionId, indexSet));
    }

    function getPositionId(
        IERC20 collateralToken,
        bytes32 collectionId
    ) public pure override returns (uint256) {
        return uint256(keccak256(abi.encodePacked(address(collateralToken), collectionId)));
    }
}
