// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IOracleAdapter
 * @notice Interface for modular oracle adapters.
 * @dev Implementations: ChainlinkAdapter (MVP), UMAAdapter (future)
 */
interface IOracleAdapter {
    // ============ Events ============

    /// @notice Emitted when a market is resolved
    event MarketResolved(
        bytes32 indexed questionId,
        int256 priceAtStart,
        int256 priceAtEnd,
        bool isUp
    );

    // ============ View Functions ============

    /**
     * @notice Returns the oracle address used for CTF condition.
     * @dev This address must match the oracle in prepareCondition.
     * @return The oracle address (typically this contract)
     */
    function oracle() external view returns (address);

    /**
     * @notice Gets the current price from the oracle.
     * @return The current price (8 decimals for Chainlink BTC/USD)
     */
    function getPrice() external view returns (int256);

    // ============ Mutative Functions ============

    /**
     * @notice Resolves a market by comparing current price to start price.
     * @dev Calls reportPayouts on CTF with appropriate payout vector.
     * @param questionId The condition's question ID
     * @param priceAtStart The price recorded at market start
     */
    function resolve(bytes32 questionId, int256 priceAtStart) external;
}
