// ============================================================================
// MOBILE HEADER — always pinned to the top, never auto-hides.
//
// The header is fixed-position and content is pushed down via
// --mobile-header-height set in render.ts after each render.
// ============================================================================

export const mobileHeaderVisible = true;

export function teardownMobileScrollTracking(): void {
	// No-op: scroll tracking removed — header is always visible.
}

export function ensureMobileScrollTracking(): void {
	// No-op: scroll tracking removed — header is always visible.
}
