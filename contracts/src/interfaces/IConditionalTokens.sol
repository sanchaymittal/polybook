// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IConditionalTokens
 * @notice Minimal interface for Gnosis Conditional Tokens Framework.
 * @dev Based on https://github.com/gnosis/conditional-tokens-contracts
 */
interface IConditionalTokens {
    // ============ Events ============

    /// @notice Emitted when a condition is prepared
    event ConditionPreparation(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint256 outcomeSlotCount
    );

    /// @notice Emitted when a condition is resolved
    event ConditionResolution(
        bytes32 indexed conditionId,
        address indexed oracle,
        bytes32 indexed questionId,
        uint256 outcomeSlotCount,
        uint256[] payoutNumerators
    );

    /// @notice Emitted when positions are split
    event PositionSplit(
        address indexed stakeholder,
        IERC20 collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 indexed conditionId,
        uint256[] partition,
        uint256 amount
    );

    /// @notice Emitted when positions are merged
    event PositionsMerge(
        address indexed stakeholder,
        IERC20 collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 indexed conditionId,
        uint256[] partition,
        uint256 amount
    );

    /// @notice Emitted when positions are redeemed
    event PayoutRedemption(
        address indexed redeemer,
        IERC20 indexed collateralToken,
        bytes32 indexed parentCollectionId,
        bytes32 conditionId,
        uint256[] indexSets,
        uint256 payout
    );

    // ============ Core Functions ============

    /**
     * @notice Prepares a condition by initializing a payout vector.
     * @param oracle The account that will report the result
     * @param questionId Unique identifier for the question
     * @param outcomeSlotCount Number of outcomes (2 for binary)
     */
    function prepareCondition(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) external;

    /**
     * @notice Reports the payout for a condition. Called by the oracle.
     * @param questionId The question being answered
     * @param payouts Array of payout numerators for each outcome
     */
    function reportPayouts(
        bytes32 questionId,
        uint256[] calldata payouts
    ) external;

    /**
     * @notice Splits collateral into conditional tokens.
     * @param collateralToken The ERC20 collateral token
     * @param parentCollectionId Parent collection (bytes32(0) for root)
     * @param conditionId The condition to split on
     * @param partition Array of index sets representing outcomes
     * @param amount Amount of collateral to split
     */
    function splitPosition(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;

    /**
     * @notice Merges conditional tokens back into collateral.
     * @param collateralToken The ERC20 collateral token
     * @param parentCollectionId Parent collection (bytes32(0) for root)
     * @param conditionId The condition to merge on
     * @param partition Array of index sets representing outcomes
     * @param amount Amount to merge
     */
    function mergePositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;

    /**
     * @notice Redeems winning positions for collateral after resolution.
     * @param collateralToken The ERC20 collateral token
     * @param parentCollectionId Parent collection (bytes32(0) for root)
     * @param conditionId The resolved condition
     * @param indexSets Array of index sets to redeem
     */
    function redeemPositions(
        IERC20 collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external;

    // ============ View Functions ============

    /**
     * @notice Returns the payout numerators for a condition.
     * @param conditionId The condition ID
     * @return Array of payout numerators
     */
    function payoutNumerators(bytes32 conditionId) external view returns (uint256[] memory);

    /**
     * @notice Returns the payout denominator for a condition.
     * @param conditionId The condition ID
     * @return The denominator (0 if not resolved)
     */
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);

    /**
     * @notice Returns the balance of a position.
     * @param owner The position owner
     * @param positionId The position ID (ERC-1155 token ID)
     * @return The balance
     */
    function balanceOf(address owner, uint256 positionId) external view returns (uint256);

    // ============ Helper Functions ============

    /**
     * @notice Computes the condition ID from its components.
     * @param oracle The oracle address
     * @param questionId The question ID
     * @param outcomeSlotCount Number of outcomes
     * @return The condition ID
     */
    function getConditionId(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) external pure returns (bytes32);

    /**
     * @notice Computes a collection ID.
     * @param parentCollectionId Parent collection
     * @param conditionId The condition
     * @param indexSet The outcome index set
     * @return The collection ID
     */
    function getCollectionId(
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) external view returns (bytes32);

    /**
     * @notice Computes a position ID.
     * @param collateralToken The collateral token
     * @param collectionId The collection
     * @return The position ID
     */
    function getPositionId(
        IERC20 collateralToken,
        bytes32 collectionId
    ) external pure returns (uint256);

    /**
     * @notice Returns the number of outcome slots for a condition.
     * @param conditionId The condition ID
     * @return The outcome slot count
     */
    function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256);
}
