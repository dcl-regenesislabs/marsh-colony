# Analytics Event Layer — Requirements (PostHog)

**Goal:** add a small, provider-agnostic event-tracking layer to the game so we can measure player behaviour. The **only mandatory event for v1 is `session started`**, which unlocks D1 / D7 / D30 retention. Everything else is added later by calling one function — the owner will specify additional events over time.

This is the original requirements doc. **Sections 1–10 are the pre-build spec; the "As-built" section just below is the current reality** — read it first. When they disagree, the code wins.

---

## As-built (current implementation)

- **Choke point:** [`src/shared/analytics.ts`](../src/shared/analytics.ts). Signature is `trackEvent(name, distinctId, properties)` — the wallet is passed explicitly (not a singleton), so it works unchanged on both the server and the client. Transport is `signedFetch` (the authoritative-server runtime has no global `fetch`; PostHog ignores the extra DCL signature headers). Silent on success; logs only on a rejected/failed send.
- **Runtime master switch — no redeploy.** `ANALYTICS_ENABLED` is resolved at runtime from the env var via [`src/server/analyticsConfig.ts`](../src/server/analyticsConfig.ts) (server-only; TTL-cached, ~60s) and relayed to the client in the state snapshot. `config.ts`'s `ANALYTICS_ENABLED` is only the fallback default (`false`). Flip it with:
  ```
  npx sdk-commands storage env set ANALYTICS_ENABLED --value true   # or false
  ```
  An empty read keeps the current value (so a transient storage failure never flips it off); to disable, set `"false"` explicitly — do not delete the var. Confirm the resolved value in the server log (`[analytics] enabled=...`, via `npm run server-logs`) and delivery in PostHog → Live events.
- **Event catalog (all carry `game: "mydearpet"` + `$lib`):**

  | Event | Side | Key properties |
  |---|---|---|
  | `session started` | server | `is_new_user`, `level`, `tutorial_complete` |
  | `session ended` | server | `duration_seconds` (capped 4h), `source: "server"` |
  | `tutorial step reached` | client | `step`, `step_index`, `chapter`, `seconds_in_session` |
  | `tutorial completed` | client | `seconds_in_session` |
  | `level reached` | server | `level` (milestones only: `ANALYTICS_LEVEL_MILESTONES`) |
  | `feature unlocked` | server | `feature`: `breeding` \| `pet_slot` \| `first_hatch` (first-time, deduped in `achievements[]`) |

  Event names match our other scenes (CozyFarm) field-for-field, so PostHog funnels/retention queries are shared across games.

---

## 1. Design principles

- **One choke point.** All tracking goes through a single function `trackEvent(name, properties)`. Nothing else in the codebase talks to PostHog directly. This keeps us provider-independent — if we switch tools later, we change one file.
- **Fire-and-forget.** Tracking must never block, slow, freeze, or crash gameplay. If a request fails, swallow the error (log at debug level at most) and move on. Analytics is never on the critical path.
- **Wallet = identity.** The player's wallet address is the `distinct_id`. This is what ties multiple sessions to one person, which is what makes retention work.
- **Multi-game from day one.** Every event carries a `game` property (`deadsurge` | `cozyfarm` | `mydearpet`). We reuse this same layer across all three games and compare them in one PostHog project.
- **Track with intent.** Only emit events that answer a question. Do not auto-capture every click/tick — it wastes quota and adds noise.

---

## 2. Architecture

```
        game code
            │  (calls)
            ▼
      trackEvent(name, properties)     ← the single choke point
            │
            ├─────────────► PostHog capture API   (primary: analysis, cohorts, retention)
            │
            └─────────────► Storage (OPTIONAL)    (raw backup / our own copy)
```

- **Primary destination: PostHog**, sent at the moment the event happens (no batch/export job to build).
- **Optional secondary: Storage** (our `auth_server` Storage service). Writing a raw copy of each event gives us a provider-independent backup we could reprocess later. **Optional for v1** — implement the PostHog path first; add the Storage mirror only if we want it. If added, it must be inside `trackEvent` so callers don't change.

> Do **not** build a "store everything in Storage, export to PostHog later" pipeline. Storage is a key-value service and is bad at analytical queries (cohorts, funnels). Sending directly to PostHog avoids building/maintaining an exporter and means data shows up immediately.

---

## 3. PostHog capture contract

Send events by POSTing to the capture endpoint.

- **Endpoint:** `POST https://<POSTHOG_HOST>/i/v0/e/`
- **Host:** `us.i.posthog.com` (US Cloud) or `eu.i.posthog.com` (EU Cloud) — pick whichever the project is created in. Store as config.
- **Auth:** the **project API key** (public, write-only capture token, starts with `phc_`). Safe to ship in the build. Do **not** use a personal API key here.
- **No auth header needed** — the key goes in the request body.

**Request body (JSON):**

```json
{
  "api_key": "<POSTHOG_PROJECT_API_KEY>",
  "event": "session started",
  "distinct_id": "0xWALLET_ADDRESS",
  "timestamp": "2026-07-09T14:03:21.000Z",
  "properties": {
    "game": "mydearpet",
    "$lib": "dcl-sdk7-custom"
  }
}
```

Required: `api_key`, `event`, `distinct_id`. Optional: `timestamp` (ISO 8601; if omitted PostHog uses receive time — prefer sending our own), `properties`. A `200` response means the payload was accepted.

**Event naming:** use PostHog's recommended `[object] [verb]` style, lowercase (`session started`, `pet fed`, `meteor opened`). Keep names consistent — they become the metric names.

---

## 4. The mandatory event — `session started`

This one event is the whole v1 deliverable.

- **Name:** `session started`
- **When:** once, when a player enters/loads the scene and their wallet is known. **Exactly once per session** — guard against double-firing on reconnects or repeated snapshots.
- **distinct_id:** wallet address.
- **Required properties:**
  - `game` — `deadsurge` | `cozyfarm` | `mydearpet`
  - (optional but nice) `is_new_user` — true if this wallet has no prior saved state, false otherwise. Lets us split new vs returning later.
  - (optional) `platform` / `is_mobile` if available from the SDK.

**Why this unlocks retention:** PostHog's retention insight groups users into **cohorts** by the first time they fire an event, then measures the % who fire it again on later days. With `session started` keyed by wallet, we get D1 / D7 / D30 for free in the PostHog UI — no extra code.

**Definition of "session":** one scene entry = one `session started`. If we later need finer control (e.g. a session timeout), we revisit — for v1, per-entry is enough.

---

## 5. Where it runs (client vs server)

**Preference: emit `session started` from the authoritative server** (the `auth_server` side). It already knows the connected wallet, it can't be tampered with from the client, and it's the natural place to dedupe "once per session." Server-side tracking is also PostHog's recommendation for high-value events.

**Fallback:** if outbound HTTP isn't available from the server context in our setup, emit from the client instead — still keyed by wallet. Either works; server is cleaner.

---

## 6. Config

Provide via env/scene config (never hardcode secrets in random files):

- `POSTHOG_PROJECT_API_KEY` — the `phc_...` project token.
- `POSTHOG_HOST` — `us.i.posthog.com` or `eu.i.posthog.com`.
- `GAME_ID` — `deadsurge` | `cozyfarm` | `mydearpet`, injected into every event's `game` property.
- `ANALYTICS_ENABLED` — a kill switch (default true) so we can disable tracking without a redeploy.

---

## 7. `trackEvent` — expected shape (pseudocode)

```ts
// single choke point — the only thing that talks to PostHog
async function trackEvent(name: string, properties: Record<string, any> = {}) {
  if (!ANALYTICS_ENABLED) return;
  try {
    const body = {
      api_key: POSTHOG_PROJECT_API_KEY,
      event: name,
      distinct_id: currentWallet(),
      timestamp: new Date().toISOString(),
      properties: { game: GAME_ID, ...properties },
    };
    // fire-and-forget: do NOT await in a way that blocks gameplay
    postJson(`https://${POSTHOG_HOST}/i/v0/e/`, body);

    // OPTIONAL backup:
    // await storage.appendEvent(currentWallet(), body);
  } catch (_) {
    // swallow — analytics must never break the game
  }
}

// v1 usage — the only call required:
trackEvent("session started", { is_new_user: isNewUser });
```

Adding any future event must be **just another `trackEvent(...)` call** — no new plumbing.

---

## 8. Acceptance criteria (v1)

1. Entering the scene fires **exactly one** `session started` event per session, reaching PostHog with `distinct_id = wallet`, `game`, and a timestamp.
2. In PostHog, a **retention insight** built on `session started` shows D1 / D7 / D30 cohorts for real players.
3. `game` is present on every event so the three games are comparable in one project.
4. Tracking failures (network down, bad key) produce **no** visible gameplay impact.
5. `ANALYTICS_ENABLED = false` cleanly disables all tracking.
6. Adding a second event later requires only a new `trackEvent()` call.

---

## 9. Verify before building (Decentraland specifics — do not assume)

- **Outbound HTTP from an SDK7 scene:** confirm the correct fetch mechanism and whether the PostHog host must be added to the scene's network allowlist (`scene.json`). Verify whether the request must go through the client's signed-fetch path or can originate from the authoritative server.
- **Wallet availability + timing:** confirm the earliest reliable point where the connected wallet is known, so `session started` fires with a real `distinct_id` (not anonymous).
- **Once-per-session guard:** confirm what signal marks a fresh scene entry vs. a reconnect/snapshot, to avoid double counting.
- Confirm current PostHog host + endpoint in the project settings (US vs EU) after the account is created.

---

## 10. Explicitly out of scope for v1 (design so they fit later)

- **Feature flags / A/B testing** (PostHog `/flags` endpoint) — for experiments like "tutorial vs meteor onboarding." Not now, but keep `trackEvent` and the identity model compatible so we can add an experiment property later.
- Any event beyond `session started`. The owner will specify the next events (e.g. `tutorial completed`, `first core action`, `meteor opened`, `breeding done`) once this foundation is live.
