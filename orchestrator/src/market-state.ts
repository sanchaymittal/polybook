/**
 * PolyBook v1 - Market State
 *
 * Stores created market state for use across scripts.
 */

// Market created in Phase 2
export const MARKET_STATE = {
    // Oracle address (deployer for mock)
    oracle: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const,

    // Question ID for BTC-UP-DOWN-5MIN market
    questionId: '0xc69e8b8e5521b4f738cbe4bc5da273f880f9c45880f67543ca5d467bc1d8b0c5' as const,

    // Condition ID (computed by CTF)
    conditionId: '0xd9116a0d7566d8c6d1e5914fcc328bdf0db42a4c1b9a4d7c9ccf1ebbbb66e3d5' as const,

    // Outcome count
    outcomeSlotCount: 2,

    // Token IDs (computed in Phase 3)
    yesTokenId: 41069470821908003820423618366673725376269941223722400569053573765861956451072n,
    noTokenId: 56313735484794408456925599043858882156820008852269395108189660012550632661236n,
} as const;
