# CLAUDE.md

This file is written for Claude Code (or any future dev) picking this project up.
It documents what exists, why it's built the way it is, and what's next.

## What this is

A live "ticker" dashboard for monday.com: a scrolling feed of recent comments across
chosen boards, per-board status cards, a clickable people list, and a daily
check-in/check-out summary — built for a CEO to get a fast overview of team activity
without opening monday.com itself.

Right now it runs as **a local Node server + a browser tab**, started by double-clicking
a launcher script. The next task (see "Next task" below) is to host it properly so
anyone can just open a URL.

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

## Frontend state machine

`public/index.html`'s JS has three screens, toggled via `display: none/block`:

1. `#connect-screen` — paste API token.
2. `#picker-screen` — after connecting, choose up to `MAX_TRACKED_BOARDS` (8) boards
   from a searchable, workspace-grouped list. Shown automatically on first connect (no
   saved selection) or via the "Edit boards" button. Selection persists in
   `localStorage` under `monday_selected_boards` (this is fine to persist across
   sessions, unlike the token — it's not sensitive).
3. `#dashboard` — the actual ticker/cards/people-bar UI.

Key state variables (all module-scope `let`s near the top of the `<script>`):
- `TOKEN` — session-only, from `sessionStorage`.
- `selectedBoardIds` — persisted board picks, from `localStorage`.
- `boardsData` — full fetched detail (columns, items) for each selected board, rebuilt
  every `loadAll()` (auto every 5 min, or via "Refresh now").
- `recentUpdates` — the comments feed powering the ticker.
- `personDataCache`, `checkinCache` — per-person on-demand fetch results, cached by
  name, cleared whenever `loadAll()` re-runs (board data changed underneath them).

## Known limitations / things not yet handled

- No pagination beyond the first `limit` on any query (25 items/board, 100
  updates account-wide, etc.) — fine for boards in the hundreds-of-items range, would
  need work for much larger boards.
- No offline/error-retry logic beyond a single try/catch per fetch; a failed
  `loadAll()` just shows an error string in the status line.
- Single-user-at-a-time design (no multi-tenant server-side state) — this is actually
  fine as-is since all state lives client-side in each visitor's browser, but worth
  confirming still holds true if the architecture changes.
- Status/people detection is a heuristic (see quirks #6/#7 above) — a board with an
  unusual structure may not surface correctly without adjusting those heuristics.

## Next task: host it so anyone can use it via a URL

Currently this only runs if someone downloads the zip, has Node.js installed, and
double-clicks a launcher — fine for one CEO, not scalable to "anyone at Frizzon."

**Decision made:** deploy to **Render or Railway** (free/cheap tier), not a serverless
rewrite — `server.js` is close to deployable as-is on either.

To get there:

1. **Push this repo** to the (currently empty) GitHub repo:
   `https://github.com/Frizzon-rnd/mondayapi.git`
   ```
   git remote add origin https://github.com/Frizzon-rnd/mondayapi.git
   git branch -M main
   git push -u origin main
   ```
2. **Deploy `server.js` as a web service** on Render or Railway, pointed at that repo.
   - Both platforms auto-detect Node and run `node server.js` (or configure a start
     command explicitly if needed).
   - `server.js` already reads `PORT` from `process.env.PORT` — required by both
     platforms, already handled, no change needed.
   - No environment variables/secrets are needed at deploy time — the monday.com token
     is supplied by each visitor in the browser, not baked into the server.
3. **Verify the CORS proxy still works** once hosted — should be transparent since
   `server.js`'s logic doesn't change, only where it runs.
4. **Custom domain / access control** — decide whether this should be open to anyone
   with the URL, or gated (e.g. behind a company VPN, a simple shared password, or an
   allowlist) before wiring up a public link. Currently there is zero access control
   beyond "you need a valid monday.com token for this account" — that's a reasonable
   bar today, but worth a deliberate decision once it's on the public internet instead
   of localhost.
5. **Longer-term, consider real OAuth** instead of "paste your personal token" (see
   "Auth model" above) if this is going to be used by multiple people regularly —
   monday.com's developer platform supports building a proper installable app with an
   OAuth flow, which is the standard/expected pattern for a tool other people install
   rather than a personal script.

## Local development

```
cd public && python3 -m http.server   # NOT sufficient alone — you need server.js running
                                        # for the /monday-api proxy to exist.
node server.js                         # run this instead, from the project root
# open http://localhost:4173
```

No build step, no `npm install` required (server.js only uses Node built-ins: `http`,
`https`, `fs`, `path`).
