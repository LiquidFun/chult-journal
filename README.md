# Oliver's Chult Journal

**Read it at [brutenis.net/chult](https://brutenis.net/chult/).**

![The desk: Book I closed, with the map of Chult and the party beside it, and Book II at the edge of the desk](.github/screenshots/desk.webp)

This is the journal of Oliver Lyonbrooke, an owlin gunslinger who becomes a necromancer along the way. It covers
forty-eight sessions of a Dungeons & Dragons *Tomb of Annihilation* campaign, played from May 2024 to October 2026, in
two books: 324 pages with about 280 ink-and-watercolour pictures. The rest of the party writes in the margins: Ofar in
blue capitals, Luth'ayen in pencil. Now and then a stamp marks a note from the Dungeon Master.

![Session 27: the first sight of Omu from the rim of the valley](.github/screenshots/omu.webp)

![A page turning in Session 19](.github/screenshots/turn.webp)

![Book II, Session 47: Acererak beside a sphere of annihilation](.github/screenshots/book2.webp)

## How it was made

- The game was played in German. The journal is written in English from the players' notebooks, the Dungeon Master's
  notes and the group chat, with Claude.
- The pictures were made with Google's Nano Banana 2.1 image model from reference portraits of the characters. Each one
  was checked against the session notes and reworked over many rounds of feedback from the Dungeon Master.
- It is plain HTML, CSS and JavaScript with no framework. Each page turn is a paper fold computed frame by frame. The
  map on the desk follows the party's route, and Book II waits at the edge of the desk until you read past the end of
  Book I.

## This repository

This repository holds only the built site: `index.html` and `static/`, where every file is named by a hash of its
content. It is generated from the private campaign repository by `tools/export_web.py`, so don't edit it by hand. The
blog ([LiquidFun/brutenis.net](https://github.com/LiquidFun/brutenis.net)) includes it as a git submodule and copies it
to `/chult/` when it builds.

To read it locally, serve the folder with any static file server, e.g. `python3 -m http.server`, and open
http://localhost:8000/.
