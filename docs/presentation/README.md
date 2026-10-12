# Demo Day — docs/presentation/

Everything for demo day lives here. There are four pieces and the rendered
deck source (all four were fact-passed as of 2026-10-12 by build step 27 —
phone line, live_check counts, transfer, SMS wording, and the Portal browser
test call are the demo call path while +972 76 567 1113 is pending Telnyx
regulatory approval):

- **[PRESENTATION.md](PRESENTATION.md)** — the **slide text** for the 7–10 minute
  "Live Walkthrough & Decision Review" defined in
  [docs/challenge/code_challenge.md](../challenge/code_challenge.md) (Demo Day,
  part 2). 13 slides, each answering one question the brief asks, with speaker
  notes and a list of source files per slide. Written by **OpenCode** with a
  Telnyx-hosted model (build step 18).
- **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)** — the **run-of-show** for the 8–10 minute
  live demo (Demo Day, part 1): the two screens, the timing, the Portal browser
  test call (THE call path while the number is pending), pre-flight (account
  balance, `telnyx-edge bindings validate <id>`, `live_check.py` 23/23,
  `workflow_paths.py` 15/15, `storage_check.py` 2/2) and a checklist mapping
  each beat to the challenge requirement it shows.
- **[TALK_TRACK.md](TALK_TRACK.md)** — what Yaniv **says out loud** on Demo Day,
  first person, ready to read: a ~30 s opening, numbered live-demo beats (with
  the exact caller line, what to say to the panel and what to point at on
  screen), a ~7–10 min walkthrough of the 9 short-deck slides, the 12 most
  likely Q&A questions with grounded answers, and a ~20 s closing. Written by
  OpenCode as build step 27.
- **[deck/](deck/)** — the **rendered slide deck source** (`deck.json` plus
  `slides/*.html`, 19 HTML files), laid out by **Claude Code** from
  `PRESENTATION.md`; step 27 fact-passed the cover and slides for the
  2026-10-12 demo.
- **[deck-short/](deck-short/)** + **[PRESENTATION_SHORT.md](PRESENTATION_SHORT.md)** — a condensed 9-slide short deck (~8 min), written by OpenCode
  as build step 24; the long `deck/` and `PRESENTATION.md` are unchanged in
  structure (their slide counts stayed at 19 and 13).

## The live deck

The rendered deck is published as a Claude artifact:

<https://claude.ai/artifact/3R5GZNrRkjn3ZEKL4Vtc3t>

It is private until shared. From the artifact page it downloads as `.pptx` or
PDF. `deck/` in this folder is the source behind it.

## How the two writers split the work

`PRESENTATION.md` (the slide copy) was written by OpenCode with a Telnyx-hosted
model as build step 18. `deck/` (the laid-out HTML deck from that copy) was
produced by Claude Code. So the demo-day materials are a small side-by-side
comparison of the two tools on the same content.
