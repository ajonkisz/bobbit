# Bobbit Animation: Emotion & Character Enhancement

> **Status:** Draft  
> **Priority:** Medium  
> **Files:** `src/ui/app.css` (keyframes `blob-busy-move`, `blob-busy-eyes`, `blob-busy-shadow`)

## Goal

Make the bobbit busy animation feel more alive and emotionally expressive using Disney/Pixar animation principles. Every moment in the 10s cycle should communicate intent or feeling — no dead frames.

## Background

The bobbit sprite is a 10×9 pixel-art character rendered with `box-shadow`, animated via three concurrent CSS keyframes on a 10s loop. It can express emotion through:
- **Body:** translate, scale (squash/stretch), rotate (lean/tilt)
- **Eyes:** 5 directions (center, left, right, up, blink) swapped via `box-shadow` at stepped intervals
- **Shadow:** horizontal position tracking the sprite

Constraints: pure CSS keyframes, no JS-driven animation. The sprite is tiny (~35×32 CSS px), so subtlety matters — small changes read clearly.

---

## Steps

<!-- STEP:1 -->
### Step 1: Eyes Lead Body

**Principle:** Eye direction leads body movement (Luxo Jr. technique)  
**Rationale:** The audience reads intent from where the character looks before it moves.

**Changes to `blob-busy-eyes`:**

| Current | New | What it communicates |
|---------|-----|----------------------|
| Eyes right at 38% | Eyes right at **34%** | "I see something over there" — during the lean, before hops start |
| Eyes center at 57% | Eyes center at **54%** | Looking ahead to where it's landing, not reacting after |
| Eyes left at 67% | Eyes left at **63%** | Glancing back before the body leans left |
| Eyes center at 70% | Eyes center at **67%** | Decision made — ready to head home before body moves |

No sprite artwork changes. Percentage-only edits.

**Validation:** At 0.25x speed, eyes should shift visibly before any body translation begins. The gap should feel like "look → decide → go."

---

<!-- STEP:2 -->
### Step 2: Asymmetric Bounces

**Principle:** Asymmetry equals personality; identical motions read as mechanical.  
**Rationale:** Two bounces with different character tell a micro-story: surprise → confirmation.

**Changes to `blob-busy-move` (0–34%):**

**Bounce 1 — "Oh! What's that?" (0–19%)**
- Deepen anticipation squat: `scaleY(0.72)` → `scaleX(1.22)` (currently `0.78`/`1.18`)
- Hold the squat 1% longer (2→3%) before launch — builds tension
- Raise peak height: `translateY(-6px)` (currently `-5.5px`)
- Add forward lean on ascent: `rotate(4deg)` (currently `3deg`)
- Keep the full settle sequence — this bounce has gravitas

**Bounce 2 — "Yep, let's go!" (19–34%)**
- Shallower squat: `scaleY(0.88)` (currently `0.85`) — less wind-up, more casual
- Lower peak: `translateY(-3.5px)` (currently `-4px`)
- Add a distinct head tilt at peak: `rotate(-3.5deg)` (currently `-2deg`)
- Compress settle to 2 keyframes instead of 3 — this bounce is breezy, not weighty
- Slightly faster timing — fewer percentage points between keyframes

**Validation:** The two bounces should feel like different sentences, not the same word repeated.

---

<!-- STEP:3 -->
### Step 3: Deepen Pre-Hop Anticipation

**Principle:** Anticipation scales with emotion; bigger intent needs bigger wind-up.  
**Rationale:** The lean before hopping right should read as loading up with excitement, not just a twitch.

**Changes to `blob-busy-move` (34–39%):**

| % | Current | New |
|---|---------|-----|
| 35% | (none — gap between 34% settle and 36% lean) | Start slow crouch: `scaleY(0.88) scaleX(1.08) rotate(2deg)` |
| 36% | `scaleX(1) scaleY(1) rotate(0deg)` | Deeper crouch: `scaleY(0.83) scaleX(1.12) rotate(4deg)` — loading up |
| 37% | (none) | **Hold the crouch** — same values as 36%. This is the "held anticipation" beat. |
| 38% | `translateX(0.3px) scaleY(0.97) rotate(3deg)` | Begin release: `scaleY(0.90) scaleX(1.06) rotate(3deg)` — starting to uncoil |
| 39% | `scaleX(1) scaleY(1) rotate(0deg)` | Remove this neutral frame — flow directly into the hop squat at 41% |

The held pose at 37% is critical. It's the "winding the spring" moment that makes the hop feel intentional rather than accidental.

**Validation:** There should be a clear beat where bobbit is crouched and coiled before exploding into the first hop.

---

<!-- STEP:4 -->
### Step 4: Eager Outbound vs Relaxed Return Hops

**Principle:** Follow-through and timing convey emotion; same action at different speeds reads differently.  
**Rationale:** Going out to explore = excited. Coming home = satisfied and unhurried.

**Changes to `blob-busy-move`:**

**Outbound hops (39–57%) — eager:**
- Slightly higher arcs: hop 1 peak `translateY(-3.5px)` (currently `-3px`), hop 2 peak `translateY(-4px)` (currently `-3.5px`) — escalating excitement
- Stronger forward lean: `rotate(3deg)` → `rotate(4deg)` on launch frames
- Keep tight keyframe spacing (current timing is good)

**Return hops (70–87%) — relaxed trot:**
- Lower arcs: hop back 1 peak `translateY(-2.5px)` (currently `-3px`), hop back 2 peak `translateY(-2.5px)` (currently `-3px`)
- Minimal lean: cap at `rotate(1.5deg)` (currently `2deg`)
- Gentler landing squash: `scaleY(0.83)` (currently `0.78`) — lighter touch
- Spread keyframes 1% wider where possible — slightly slower pace

**Changes to `blob-busy-shadow`:**
- Spread return hop shadow keyframes to match the lazier body timing
- Outbound shadow timing stays tight

**Validation:** Side-by-side comparison of outbound vs return should feel like "sprint to the mailbox, stroll back."

---

<!-- STEP:5 -->
### Step 5: Expressive Settle & Moving Hold

**Principle:** Follow-through is asymmetric; a moving hold prevents death frames.  
**Rationale:** The return home is the emotional punctuation. It should feel like plopping into a chair and sighing contentedly, not braking to a stop.

**Changes to `blob-busy-move` (87–100%):**

Replace the current symmetric wiggle with damped asymmetric follow-through + breathing hold:

| % | Transform | Reads as |
|---|-----------|----------|
| 87% | `scaleX(1.18) scaleY(0.80) rotate(0deg)` | Landing squash (keep current) |
| 89% | `scaleX(0.94) scaleY(1.07) rotate(-2.5deg)` | Overshoot — lean back catching balance |
| 91% | `scaleX(1.04) scaleY(0.96) rotate(1.5deg)` | Counter-correct forward |
| 93% | `scaleX(1.01) scaleY(1.01) rotate(-0.5deg)` | Damping — almost settled |
| 95% | `scaleX(1.0) scaleY(1.012) rotate(0.2deg)` | Breathing in — satisfied sigh |
| 97% | `scaleX(1.0) scaleY(1.0) rotate(-0.15deg)` | Breathing out |
| 99% | `scaleX(1.0) scaleY(1.008) rotate(0.1deg)` | Still breathing — never fully static |
| 100% | `scaleX(1.0) scaleY(1.0) rotate(0deg)` | Loop point (must match 0%) |

**Changes to `blob-busy-eyes`:**
- Move the settle blink from 95% to **92%** — the blink happens during the follow-through, reads as "ahhh" rather than arbitrary
- Add a micro eye direction change: eyes glance slightly right at 96% then back to center at 99% — a tiny "checking in" before the cycle restarts. This fills the breathing hold with visual activity.

**Validation:** The last 1.3 seconds of the cycle should feel warm and alive. At no point should bobbit appear frozen. The loop restart at 0% should be seamless — no visible pop.

---

## Verification Checklist

After implementing all 5 steps:

- [ ] No frame where bobbit is motionless for >300ms
- [ ] Eyes shift before body moves in all 4 directional transitions
- [ ] Bounce 1 and bounce 2 feel like different emotions
- [ ] Outbound hops feel noticeably more energetic than return hops
- [ ] The settle reads as a satisfied sigh, not an abrupt stop
- [ ] Loop restart (100% → 0%) is seamless with no visual pop
- [ ] `npm run build:ui` succeeds
- [ ] All existing tests pass
- [ ] Animation looks correct at both 1x and 0.25x speed
- [ ] Idle and transition animations (`blob-idle-eyes`, `blob-enter`, `blob-exit`, etc.) still work correctly — no regressions from shared class changes
