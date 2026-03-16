import { isDesktop, hasActiveSession } from "./state.js";

// ============================================================================
// MOBILE HEADER AUTO-HIDE
//
// Uses capture-phase scroll listening on #app-main so we don't need to
// query for the specific scroll container inside Lit custom elements.
// Scroll events don't bubble, but capture: true intercepts them from
// any descendant.
//
// The header overlays content (no paddingTop management) and slides in/out
// via translateY. A CSS rule in app.css adds extra top-padding to the
// message area on mobile so the first message isn't hidden behind the header.
// ============================================================================

export let mobileHeaderVisible = true;
let _scrollCleanup: (() => void) | null = null;
let _lastTrackedScrollTop = 0;

export function setupMobileScrollTracking(): void {
	if (isDesktop() || !hasActiveSession()) {
		teardownMobileScrollTracking();
		mobileHeaderVisible = true;
		return;
	}

	// If already tracking, don't recreate
	if (_scrollCleanup) return;

	const mainEl = document.getElementById("app-main");
	if (!mainEl) return;

	_lastTrackedScrollTop = 0;

	const onScroll = (e: Event) => {
		const headerEl = document.getElementById("app-header");
		if (!headerEl) return;

		const target = e.target as HTMLElement;
		if (!target || (!target.scrollTop && target.scrollTop !== 0)) return;

		const currentTop = target.scrollTop;
		const delta = currentTop - _lastTrackedScrollTop;

		if (currentTop < 20) {
			if (!mobileHeaderVisible) {
				mobileHeaderVisible = true;
				headerEl.style.transform = "translateY(0)";
				headerEl.style.boxShadow = "";
			}
		} else if (delta < -4) {
			if (!mobileHeaderVisible) {
				mobileHeaderVisible = true;
				headerEl.style.transform = "translateY(0)";
				headerEl.style.boxShadow = "0 1px 3px rgba(0,0,0,0.1)";
			}
		} else if (delta > 4) {
			if (mobileHeaderVisible) {
				mobileHeaderVisible = false;
				headerEl.style.transform = "translateY(-100%)";
				headerEl.style.boxShadow = "";
			}
		}

		_lastTrackedScrollTop = currentTop;
	};

	mainEl.addEventListener("scroll", onScroll, { capture: true, passive: true });
	_scrollCleanup = () => {
		mainEl.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
		_scrollCleanup = null;
	};
}

export function teardownMobileScrollTracking(): void {
	_scrollCleanup?.();
}

export function ensureMobileScrollTracking(): void {
	setupMobileScrollTracking();
}
