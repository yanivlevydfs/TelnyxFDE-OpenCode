# Demo Day — docs/presentation/

Everything for demo day lives here. There are three pieces and the rendered
deck source:

- **[PRESENTATION.md](PRESENTATION.md)** — the **slide text** for the 7–10 minute
  "Live Walkthrough & Decision Review" defined in
  [docs/challenge/code_challenge.md](../challenge/code_challenge.md) (Demo Day,
  part 2). 13 slides, each answering one question the brief asks, with speaker
  notes and a list of source files per slide. Written by **OpenCode** with a
  Telnyx-hosted model (build step 18).
- **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)** — the **run-of-show** for the 8–10 minute
  live demo (Demo Day, part 1): the phone call, the two screens, the timing,
  and a checklist mapping each beat to the challenge requirement it shows.
- **[deck/](deck/)** — the **rendered slide deck source** (`deck.json` plus
  `slides/*.html`, one HTML file per slide), laid out by **Claude Code** from
  `PRESENTATION.md`. These files are left unchanged.

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
