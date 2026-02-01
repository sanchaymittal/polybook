// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IYellowVerifier
 * @notice Interface for verifying Yellow/Nitrolite state channel proofs.
 * @dev Placeholder interface - actual implementation depends on Yellow Network specs.
 */
interface IYellowVerifier {
    /**
     * @notice Verifies a state root and its associated proof from Yellow L2.
     * @param stateRoot The Merkle root of the final state
     * @param proof The proof data signed by Yellow validators
     * @return valid True if the proof is valid
     */
    function verify(bytes32 stateRoot, bytes calldata proof) external view returns (bool valid);

    /**
     * @notice Decodes agent positions from the state root.
     * @param stateRoot The Merkle root of the final state
     * @param agent The agent address to look up
     * @param marketId The market ID
     * @return upPosition The agent's UP outcome position
     * @return downPosition The agent's DOWN outcome position
     */
    function getAgentPosition(
        bytes32 stateRoot,
        address agent,
        uint256 marketId
    ) external view returns (uint256 upPosition, uint256 downPosition);
}
