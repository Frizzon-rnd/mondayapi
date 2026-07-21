monday.com Live Ticker — standalone local app
==============================================

What this is
-------------
A small local dashboard that shows a live scrolling "ticker" of what's
happening across up to 8 of your monday.com boards (your choice, picked
after connecting), plus per-board status cards. Click a person's name to
filter everything to just their items, and see their check-in board
history in a highlighted panel.

Requirements
------------
- Node.js installed (v18 or newer). Check with: node -v
- Your own monday.com personal API token
  (monday.com -> Avatar -> Admin -> API, or Profile -> Developers -> My Access Tokens)

How to run (no terminal typing needed)
---------------------------------------
Mac:     double-click "start.command"
Windows: double-click "start.bat"

A window will pop up (that's normal, it's just showing status) and your
browser will open automatically to the ticker. Paste your monday.com API
token and click Connect.

The only one-time setup required is having Node.js installed — if it's
missing, the launcher will tell you and link to https://nodejs.org.

(If you'd rather run it manually: open a terminal in this folder and run
"node server.js", then open http://localhost:4173 yourself.)

Notes on privacy
----------------
Your token is only kept in this browser tab (sessionStorage) and is sent
to this local server, which forwards it directly to monday.com's API.
It is never sent anywhere else, and clears when you close the tab or
click Disconnect.

Which boards it shows
----------------------
After you connect with your API token, you pick up to 8 boards from a
searchable list of everything in your account (grouped by workspace).
Your picks are saved in this browser (localStorage) so you won't be
asked again — use "Edit boards" in the header anytime to change them.

This is deliberately capped at a small, explicit selection rather than
"everything in a workspace." Auto-discovering and fetching every active
board's full item data in one request turned out to be unreliable:
monday.com enforces a per-query complexity limit, and with 30+ boards
in one request that limit would get hit, causing boards to randomly
appear/disappear between refreshes depending on which request happened
to succeed. A small, explicit selection has no such problem.

Auto-generated "Subitems of ..." boards are hidden from the picker
since they're never something you'd deliberately choose.

Customizing
-----------
- Max boards selectable: MAX_TRACKED_BOARDS constant in public/index.html
- Port: set the PORT environment variable, e.g. PORT=5000 node server.js
- Refresh interval: currently every 5 minutes (setInterval call near the
  bottom of public/index.html)
