// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IChainlinkAggregator
 * @notice Interface for Chainlink AggregatorV3 price feeds.
 * @dev Used to fetch BTC/USD price at market start and resolution.
 */
interface IChainlinkAggregator {
    /**
     * @notice Returns the latest price data from the oracle.
     * @return roundId The round ID of the price update
     * @return answer The current price (scaled by decimals)
     * @return startedAt Timestamp when the round started
     * @return updatedAt Timestamp when the price was last updated
     * @return answeredInRound The round ID in which the answer was computed
     */
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    /**
     * @notice Returns the number of decimals in the price feed.
     * @return The number of decimals
     */
    function decimals() external view returns (uint8);

    /**
     * @notice Returns a description of the price feed.
     * @return The description string
     */
    function description() external view returns (string memory);
}
