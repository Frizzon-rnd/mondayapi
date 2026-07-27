# CLAUDE.md

This file is written for Claude Code (or any future dev) picking this project up.
It documents what exists, why it's built the way it is, and what's next.

## What this is

A live dashboard for monday.com: a live-updating comment feed across chosen boards
(styled like a chat/live-comments panel), per-board status cards, a clickable people
list, and a daily check-in/check-out summary — built for a CEO to get a fast overview
of team activity without opening monday.com itself.

**Status: hosted and live.** It's deployed as a Render web service at
`https://mondayapi-rcqy.onrender.com`, backed by `github.com/Frizzon-rnd/mondayapi`
(`main` branch, auto-deploys on push). It also still runs locally exactly the same way
(local Node server + browser tab, via `start.command`/`start.bat` or `node server.js`)
for development. See "Hosting" below for deploy details, and "Next task" for what's
still queued up (real-time push via webhooks).

## Origin story / why some things look the way they do

This was built iteratively in a chat session, debugging real data issues against a live
monday.com account (Frizzon) along the way. Several design decisions exist *because of*
bugs discovered in that process — they're not arbitrary, so don't undo them without
re-reading the reasoning below.

## Architecture

```
monday-ticker-app/
  server.js           Tiny Node HTTP server. Two jobs:
                         1. Serves public/index.html and static assets.
                         2. Proxies POST /monday-api -> https://api.monday.com/v2,
                            forwarding {token, query, variables} as the GraphQL body.
  public/index.html    The entire frontend: HTML + CSS + JS in one file, no build step,
                        no framework, no npm dependencies. Talks to monday.com only
                        through the server.js proxy via fetch('/monday-api', ...).
  package.json         Minimal (name/start script/engines) — added purely so Render's
                        Node auto-detect has something to key off. No dependencies;
                        local dev still just runs `node server.js` directly.
  start.command         Double-clickable launcher for macOS (opens Terminal briefly,
  start.bat             starts server.js, opens the browser to localhost:4173).
                         Windows equivalent.
  README.txt            End-user instructions (non-technical audience).
```

There is **no build step, no bundler, no React/Vue/etc.** The frontend is intentionally
plain JS in a single file. If this grows significantly, consider introducing a build
step, but don't add one just for its own sake — the simplicity has been a feature so
far (easy to hand-edit, easy to reason about, zero install footprint beyond Node
itself).

## Why there's a server at all (the CORS constraint)

monday.com's `api.monday.com/v2` GraphQL endpoint **does not send CORS headers**, so a
browser cannot call it directly from arbitrary origins — confirmed via monday's own
community forum threads (multiple reports of "No 'Access-Control-Allow-Origin' header
is present"). This is why `server.js` exists: it's a same-origin proxy so the browser's
`fetch('/monday-api')` call succeeds, and `server.js` makes the actual cross-origin
request to monday.com server-side, where CORS doesn't apply.

**Any hosting solution must preserve this proxy.** A pure static host (GitHub Pages,
plain S3, etc.) will NOT work — you need something that can run server-side code
(Node process, serverless function, edge function). See "Next task" below.

## Auth model

- User pastes their own **personal monday.com API token** into the page.
- Token is kept in `sessionStorage` (clears when the tab closes), never `localStorage`.
- Token is sent to `server.js` per-request in the POST body; `server.js` forwards it as
  the `Authorization` header to monday.com and does not log or store it anywhere.
- This is intentionally simple (not OAuth) because it started as a single-user local
  tool. **If this becomes multi-tenant/public-facing, revisit this** — monday.com has a
  real OAuth app platform (their developer/marketplace center) that's the proper way to
  do this for a public tool instead of "paste your personal token." See "Next task."

## Data model quirks discovered (important — re-read before "fixing" something that looks buggy)

These are the non-obvious things that caused real bugs during development. Each one is
also documented inline as a code comment near where it's handled.

1. **`item.updated_at` only reflects column value changes, not comments.** Posting a
   comment (an "update" in monday's terms) does NOT bump an item's `updated_at`. This
   matters a lot for the "Daily - Check in / Check out" board, where check-ins are
   posted as comments on a static per-employee item, not as column edits. Relying on
   `updated_at` there showed check-ins as "12 days old" when someone had actually
   checked in hours ago. Fix: check-in freshness is read from the item's `updates`
   (comment thread) directly, via `fetchCheckinForPerson()`.

2. **`items_page` has no default recency sort.** Without an explicit `order_by`, monday
   returns items in an arbitrary/creation order, not newest-first. Every items_page
   query in this app explicitly sorts with:
   ```graphql
   query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }
   ```
   (`__last_updated__` and `__creation_log__` are special pseudo-column IDs monday
   supports for this — no real column of that ID needs to exist on the board.)

3. **Board-level `updated_at` (from a plain `boards { updated_at }` query) is NOT a
   reliable proxy for "this board has recent activity."** It can reflect structural
   changes (a view added, a column renamed) rather than item activity. Don't use it to
   decide which boards are "hot" — instead fetch each board's items and compute the max
   `item.updated_at` client-side (see `latestActivity` in `loadAll()`).

4. **monday.com enforces a per-query complexity budget**, and this app hit it hard when
   it tried to auto-discover and fully fetch "every active board in a workspace" (30-40
   boards × columns × 25 items each, in one GraphQL request). The symptom was bizarre:
   boards would randomly appear/disappear between refreshes depending on whether that
   particular request happened to fit under the budget, and the error handling at the
   time silently left stale data on screen instead of surfacing the failure. **This is
   why board selection is now a small, explicit, user-picked list (max 8, enforced by
   `MAX_TRACKED_BOARDS`)** rather than "discover everything" — small fixed requests
   don't hit the limit. If you reintroduce broader auto-discovery, either paginate/batch
   the detail-fetch into small chunks (e.g. 5-8 boards per request) or trim requested
   fields (columns, items_page limit) accordingly, and add visible error reporting so a
   partial failure is never silently invisible.

5. **The `updates` query (comments) is only filterable by board client-side.** monday's
   root-level `updates(limit, from_date, to_date, ids)` query returns account-wide
   comments and doesn't accept a board or workspace filter server-side. This app fetches
   up to 100 recent updates account-wide and filters down to the selected board IDs in
   JS (`fetchRecentUpdates()`). If the account is very active, 100 may not be enough to
   surface comments from all 8 selected boards — worth watching, and `limit` can go up
   to monday's max of 100 per page (would need pagination beyond that).

6. **People/status detection is column-*type*-based, not name-based.** `findStatusColumns`
   matches columns of type `status` or `color`; `findPeopleColumns` matches type
   `people` (and a defensive `multiple-person`, which likely doesn't actually occur but
   is harmless to keep). This generalizes across boards with different column IDs/names,
   which is necessary since each board has its own arbitrary column IDs.

7. **Check-in board matching is intentionally NOT people-column based.** Early attempts
   used generic "any people-type column" matching for whose check-in an item belonged
   to, which caused false attribution (an item got matched to a person because they were
   listed in an unrelated "Reporting Manager" column, not because it was their check-in).
   Check-in boards have one item per employee with the employee's name as the item's
   `name` field — so matching is done via `column_id: "name", operator: contains_text`
   instead. If you add support for a differently-structured check-in board, this
   assumption may not hold.

8. **The account has multiple workspaces, and boards must be scoped to one.** This
   account has an active "Task Management" workspace (~35-40 real boards) and an
   archived "Past Projects" workspace with many old client boards (Krafton, Soapbox,
   Lollapalooza, etc.). An early version of the board picker queried `boards(limit: 200)`
   with no workspace filter, which (a) mixed active and archived boards together in the
   picker, and (b) **silently dropped a real active board** (`Post Production Task`, id
   `1439508566`) off the end of the unpaginated 200-item result once both workspaces'
   boards were combined, with no error surfaced — the same "silent partial failure"
   failure mode as quirk #4, just triggered by a different cause. Fix: a workspace
   picker screen now runs before the board picker (`query { workspaces(limit: 50) { id
   name } }`), and the board query is scoped with `workspace_ids: [<chosen_id>]`
   (confirmed-working argument). Don't go back to an unfiltered `boards` query without
   re-solving this.

9. **The account-wide `updates(limit: 100)` snapshot can silently "lose" a comment
   before you ever see it.** The live comment feed (see "Live comment feed" below) reads
   this query, then filters client-side to tracked boards (quirk #5). If enough
   unrelated comments happen elsewhere in the account between one fetch and the next, an
   older tracked-board comment can fall out of that top-100 window entirely — this is
   exactly what caused check-in comments to appear "an hour old" even though the person
   had checked in recently: by the time the (then 5-minute) poll ran again, other
   account activity had already pushed that comment past position 100. Fix: poll far
   more often (every `COMMENT_POLL_MS`, currently 9s) and accumulate results
   client-side (`commentFeed`/`seenUpdateIds` in `mergeIntoCommentFeed()`) instead of
   replacing the displayed list with each raw snapshot — once a comment has been seen,
   it stays in the feed regardless of what the API returns afterward. This is a
   mitigation, not a structural fix: on an extremely chatty account it's still
   theoretically possible for >100 comments to land between two 9-second polls. The
   real fix is webhooks (see "Next task").

10. **Check-in and check-out are the same kind of comment, distinguished only by text,
    not a column.** Confirmed against real account comments (e.g. "CHECK-OUT: 21 May
    2026...", "Check out update: ...") — employees post a "Check In" comment in the
    morning and a separate "Check Out" comment later on the *same* per-employee item on
    the check-in board; monday.com has no structured field marking which is which (same
    "comments, not columns" situation as quirk #1/#7). `computeCheckinStatuses()` looks
    at whichever of *today's* comments for a person came last and classifies it with
    `CHECKOUT_PATTERN` (`/check[\s-]?out/i`): if their most recent comment today is a
    check-out, their status is `'out'` (red dot again) rather than staying green for the
    rest of the day just because they posted a check-in-shaped comment earlier. If they
    haven't posted anything today at all, status is `'none'` (red after
    `CHECKIN_HOUR_GATE`, gray before). The People sidebar (`renderPeopleSidebar()`) also
    sorts anyone not currently `'in'` to the top of the list, ahead of the normal
    by-task-count order, so "who isn't working right now" is the first thing visible.

## Frontend state machine

`public/index.html`'s JS has four screens, toggled via `display: none/block`:

1. `#connect-screen` — paste API token.
2. `#workspace-picker-screen` — after connecting, pick exactly one monday.com
   workspace (`query { workspaces(limit: 50) { id name } }`). Shown automatically when
   there's no saved workspace choice, or via "Change workspace" from the board picker.
   Selection persists in `localStorage` under `monday_selected_workspace`. Switching
   workspaces clears the current board selection (`selectWorkspace()`), since board
   picks from one workspace don't carry meaning in another.
3. `#picker-screen` — choose up to `MAX_TRACKED_BOARDS` (8) boards from a searchable
   list, scoped to the chosen workspace (`workspace_ids: [selectedWorkspaceId]`, see
   quirk #8). Shown automatically after the workspace picker on first-time setup, or via
   the "Edit boards" button (reopens directly for the *same* workspace — fewer clicks
   for the common case of just tweaking board picks). Selection persists in
   `localStorage` under `monday_selected_boards`.
4. `#dashboard` — the actual cards/people-bar/live-comment-feed UI.

Key state variables (all module-scope `let`s near the top of the `<script>`):
- `TOKEN` — session-only, from `sessionStorage`.
- `selectedWorkspaceId` — persisted workspace pick, from `localStorage`.
- `selectedBoardIds` — persisted board picks, from `localStorage`.
- `boardsData` — full fetched detail (columns, items) for each selected board, rebuilt
  every `loadAll()` (auto every 5 min, or via "Refresh now").
- `recentUpdates` — latest account-wide comments snapshot (replaced each poll); feeds
  the check-in summary card (`renderCheckinBoardCard()`).
- `commentFeed` / `seenUpdateIds` — the ever-growing, deduped list behind the live
  comment feed sidebar (see below). Unlike `recentUpdates`, this only ever grows within
  a given board selection; reset in `saveSelectedBoardIds()` whenever the tracked boards
  change.
- `personDataCache`, `checkinCache` — per-person on-demand fetch results, cached by
  name, cleared whenever `loadAll()` re-runs (board data changed underneath them).

## Live comment feed (right-hand sidebar)

Replaced the original horizontally-scrolling ticker. Renders in `#comment-feed-col` as
a scrollable, chat-like panel — newest comment on top, full scrollback below, capped at
`COMMENT_FEED_MAX` (300) entries.

- `refreshCommentFeed()` runs on its own interval (`feedPollTimer`, every
  `COMMENT_POLL_MS` = 9000ms) — separate from the 5-minute `loadAll()` board refresh,
  since it's a much lighter query (`fetchRecentUpdates()`, no board/item nesting) and
  safe to poll far more often.
- `mergeIntoCommentFeed()` is what makes the feed feel "live" without needing websockets
  or webhooks: each poll's results are merged into `commentFeed` by id, not used to
  replace it — see quirk #9 for why a naive "just re-render the latest snapshot"
  approach was actively wrong (it made check-in comments look stale).
- This is intentionally the simple, no-new-infrastructure option (polling + client-side
  accumulation). A genuinely instant, push-based version (monday.com webhooks + Server-
  Sent Events) was evaluated and deliberately deferred — see "Next task" below for what
  that would take.

## Project cards: Focus View, per-task chips, and staleness

`renderProjectCards()` renders one card per tracked non-check-in board. Several
behaviors here generalize off column *type and title* rather than board IDs — same
philosophy as quirk #6/#7 — so they apply automatically to whichever tracked boards
happen to have the matching columns, not just the board they were originally built for.

- **Focus View (Projects/Pitches split).** Any board with a status/color-typed column
  titled exactly "Label" (`findLabelColumn`, `LABEL_COLUMN_PATTERN`) gets its task list
  split into two sections instead of one flat list — **Projects** (green, `#00c875`) and
  **Pitches** (yellow, `#ffcb00`), matched against the Label column's text via
  `FOCUS_PROJECT_PATTERN`/`FOCUS_PITCH_PATTERN`. Items labeled "Follow Up/Limbo" or "No
  updates" (`FOCUS_HIDDEN_LABEL_PATTERN`) are dropped entirely rather than folded into
  either section. This currently fires on **two** boards in this account — Project
  Manager Frizzon and Project Tracker 2026 — which both happen to have a "Label" column
  with the same option set; this was confirmed and accepted deliberately rather than
  hardcoded to one board id, so a third board with the same column convention would get
  the same treatment automatically.
- **Per-task meta chips.** Every task row shows small chips for whichever of
  Deadline/Label/Status/Priority a board actually has (`findDeadlineColumn` matches a
  `date`-typed column titled containing "deadline"; `findLabelColumn`/`findStatusColumn`/
  `findPriorityColumn` as above) — a board missing one of these columns just shows fewer
  chips, nothing breaks. Inside a Focus View group the Label chip is suppressed
  (`skipLabel`) since the Projects/Pitches section header already says which one it is.
- **Comment-based recency, scoped to Focus View boards.** Same root cause as quirk #1:
  `updated_at` doesn't move when someone just comments on a task. For boards with a Label
  column specifically (`needsCommentRecency = !!labelCol` in `loadAll()`), the item fetch
  opts into pulling each item's own recent comments (`fetchItemsPage(...,
  includeLastComment)` → `updates(limit: 10) { created_at }`), and
  `effectiveActivityTime(it)` prefers the max comment time (`lastCommentAt`) over
  `updated_at`. This is opt-in per board, not global — turning it on for every board would
  risk quirk #4's complexity budget on huge boards like Post Production Task (1000+
  items) for no benefit, since the Label-column boards were the only ones actually
  showing stale-looking "recent" activity that was really just an old column edit.
- **Stale-task highlight.** Any task whose `effectiveActivityTime` is older than 24h
  (`isStaleUpdate`, `STALE_UPDATE_MS`) renders with a red-tinted row and a bold red
  timestamp — on every board, not just Focus View ones (falls back to `updated_at` where
  comment data wasn't fetched).

## Known limitations / things not yet handled

- No pagination beyond the first `limit` on any query (25 items/board, 100
  updates account-wide, etc.) — fine for boards in the hundreds-of-items range, would
  need work for much larger boards.
- No offline/error-retry logic beyond a single try/catch per fetch; a failed
  `loadAll()` just shows an error string in the status line.
- Single-user-at-a-time design (no multi-tenant server-side state) — this is actually
  fine as-is since all state lives client-side in each visitor's browser, but **stops
  holding true if the webhook/SSE work above is picked up**, since a webhook is a
  shared per-board resource, not a per-visitor one. See "Next task" for what changes.
- Status/people detection is a heuristic (see quirks #6/#7 above) — a board with an
  unusual structure may not surface correctly without adjusting those heuristics.
- The live comment feed's polling mitigation (quirk #9) is not a structural fix — on an
  extremely chatty account it's theoretically still possible to miss a comment between
  two 9-second polls. Webhooks (see "Next task") are the real fix.

## Hosting (done)

Deployed as a Render web service (Hobby/free workspace plan), auto-deploying from
`github.com/Frizzon-rnd/mondayapi` on push to `main`. Live at
`https://mondayapi-rcqy.onrender.com`.

- Build command: `npm install` (a no-op today — no dependencies — but required by
  Render's form and harmless).
- Start command: `node server.js` (or `npm start`, same thing via `package.json`).
- No environment variables/secrets needed — the monday.com token is supplied by each
  visitor in the browser, never baked into the server, per the Auth model above.
- **Instance type is Free**, which spins the service down after 15 minutes with no
  traffic and takes ~30-60s to wake on the next request. This only affects the *first*
  page load after a gap — once a tab is open, polling/refreshing continues normally
  with no further delay. If that cold-start delay becomes annoying in practice, the fix
  is upgrading to Render's Starter tier (~$7/mo, always-on), not switching platforms.
- **This repo is pushed from this machine via a dedicated SSH deploy key**
  (`~/.ssh/frizzon_mondayapi_deploy`), scoped to this repo only via `core.sshCommand` in
  this repo's local `.git/config` — it does not use or affect the machine's default
  `gh`/git identity. A `Host github.com` block was also added to `~/.ssh/config` to
  override a pre-existing global `RemoteCommand`/`RequestTTY` setting (unrelated Warp
  terminal tmux integration) that was silently breaking all git-over-SSH on this
  machine. Neither of these is portable to a different machine — a fresh clone
  elsewhere would need its own deploy key added to the GitHub repo's Settings → Deploy
  Keys (with write access) to push.

## Next task: real-time comments via monday.com webhooks (a.k.a. "Option B")

The live comment feed currently works by **polling** (`refreshCommentFeed()` every 9s,
see "Live comment feed" above) — good enough that it feels close to live, and it
already fixed the "check-in comments look an hour old" bug. The next real upgrade is
**push-based delivery**: monday.com fires a webhook the instant a comment is posted,
and the server relays it to the browser instantly via Server-Sent Events (SSE) instead
of the browser ever polling. This was evaluated in detail before deciding to ship
polling first; the plan below is what's left if/when this gets picked up.

**What changes:**
- `server.js` gains a webhook receiver (`POST /webhook`) and an SSE endpoint
  (`GET /events`) — this turns it from a stateless request/response proxy into a
  long-lived, stateful process for the first time.
- `server.js` also needs to create/delete monday.com webhook subscriptions
  (`create_webhook`/`delete_webhook` mutations) per board whenever someone's tracked
  board selection changes.
- monday.com verifies a new webhook with a **challenge/response handshake** — right
  after registering, it POSTs `{"challenge": "..."}` to the receiver and expects the
  same value echoed back within a few seconds, or the webhook never activates. Must be
  handled correctly in the receiver.
- The frontend swaps its polling `setInterval` for an `EventSource` connection to
  `/events`.

**Supporting multiple people, each with their own board selection ("Option 2" of the
three multi-user scenarios considered — see below), needs more than the above:**
- A server-side registry, e.g. `boardId -> { webhookId, refCount }`. Each SSE
  connection tells the server which board IDs it cares about (e.g.
  `/events?boards=1,2,3`); a board's webhook is created the first time *anyone* is
  watching it, and deleted only once *nobody* is.
- A short grace period before actually deregistering a board's webhook on
  disconnect — a page reload momentarily drops and reopens the SSE connection, and
  without a delay (e.g. 30-60s) you'd get needless create/delete churn on every reload.
- Incoming webhook events get routed only to the SSE connections that have that board
  in their filter list — everyone else's stream stays quiet.
- **A new dedicated service token**, stored as a Render environment variable, used only
  for webhook create/delete calls — separate from the per-visitor tokens used
  everywhere else. Webhook registration is server-initiated (not a per-visitor request
  being relayed), and needs to work reliably even during startup reconciliation, not
  just while a specific person's tab happens to be open. This is a real, deliberate
  departure from today's "zero secrets stored server-side" model — worth deciding on
  explicitly rather than backing into.
- **Restart recovery**: the registry above lives in memory and is lost on every
  restart/redeploy. Reconnecting clients naturally re-trigger registration for their
  own boards, but webhooks left over from before the restart that are now orphaned
  won't clean themselves up without an explicit startup reconciliation step (list
  existing webhooks from monday.com, diff against what's currently being watched,
  delete the stragglers).
- **Render's free tier and this don't mix well.** If the container is asleep when
  monday.com POSTs a webhook or its challenge handshake, the ~30-60s cold-start wake
  can cause the handshake to time out (webhook fails to register) or a real event to
  get dropped. Reliable webhook delivery basically requires the Starter (~$7/mo,
  always-on) tier.

**Three tiers of "multiple users" were considered — worth re-reading before assuming
which one is meant if this comes up again:**
1. *Multiple people at Frizzon watching the same board selection simultaneously* —
   already fine with either polling or SSE; broadcasting to multiple open tabs needs no
   extra work.
2. *Multiple people, each with their own different board selection, same monday.com
   account* — the scenario the plan above is for. Real but contained work: a
   ref-counted registry and per-connection event filtering, still one server, one
   monday.com account, no new auth model.
3. *Multiple different companies/monday.com accounts using this same hosted app* — a
   much bigger step, out of scope unless explicitly requested. "Paste your personal
   token" stops working as an auth model here — this needs monday.com's real OAuth app
   flow (so each company delegates access to its own account) and a persistent
   datastore (not in-memory) mapping tenants to their own tokens/webhooks/board
   selections. This is the same "longer-term, consider real OAuth" note from the Auth
   model section above, just spelled out for the webhook case specifically.

## Local development

```
cd public && python3 -m http.server   # NOT sufficient alone — you need server.js running
                                        # for the /monday-api proxy to exist.
node server.js                         # run this instead, from the project root
# open http://localhost:4173
```

No build step, no `npm install` required (server.js only uses Node built-ins: `http`,
`https`, `fs`, `path`).
