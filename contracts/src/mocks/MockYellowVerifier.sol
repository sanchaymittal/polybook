// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IYellowVerifier} from "../interfaces/IYellowVerifier.sol";

/**
 * @title MockYellowVerifier
 * @notice Mock Yellow verifier for testing.
 * @dev Always returns valid proofs and allows setting agent positions.
 */
contract MockYellowVerifier is IYellowVerifier {
    // ============ State Variables ============

    /// @notice Whether verify() should return true
    bool public shouldVerify = true;

    /// @notice Stored positions for testing
    /// @dev marketId => agent => (upPosition, downPosition)
    mapping(uint256 => mapping(address => Position)) private _positions;

    struct Position {
        uint256 upPosition;
        uint256 downPosition;
    }

    // ============ External Functions ============

    /**
     * @notice Sets whether proofs should verify.
     * @param _shouldVerify True to accept all proofs
     */
    function setShouldVerify(bool _shouldVerify) external {
        shouldVerify = _shouldVerify;
    }

    /**
     * @notice Sets an agent's position for testing.
     * @param marketId The market ID
     * @param agent The agent address
     * @param upPosition The UP outcome position
     * @param downPosition The DOWN outcome position
     */
    function setAgentPosition(
        uint256 marketId,
        address agent,
        uint256 upPosition,
        uint256 downPosition
    ) external {
        _positions[marketId][agent] = Position(upPosition, downPosition);
    }

    // ============ IYellowVerifier Implementation ============

    /**
     * @notice Always returns shouldVerify state.
     */
    function verify(
        bytes32, /* stateRoot */
        bytes calldata /* proof */
    ) external view override returns (bool) {
        return shouldVerify;
    }

    /**
     * @notice Returns the stored position for an agent.
     */
    function getAgentPosition(
        bytes32, /* stateRoot */
        address agent,
        uint256 marketId
    ) external view override returns (uint256 upPosition, uint256 downPosition) {
        Position memory pos = _positions[marketId][agent];
        return (pos.upPosition, pos.downPosition);
    }
}
