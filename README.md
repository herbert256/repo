# Flora Nusquam

*or, A Herbarium of Plants that have never grown.*

**→ https://herbert256.github.io/repo/**

An endless herbarium of 3999 impossible plants. Each plate is a hand-coloured
19th-century botanical engraving that draws itself, line by line, while you watch.
Each comes with a Latin name, a botanical description, field notes from one of
the herbarium's (equally imaginary) collectors, its folklore, and its **song**.

- **Every plant is fixed.** A plant comes from its plate number alone, so plate XLII
  is the same plant for every reader on every day.
- **Every plant sings.** The key comes from the colour of the flower, read through
  Scriabin's colour–key table. The time signature follows the petal count (a
  five-petalled flower sings in 5/4), the mode follows the flower's shape and the
  tempo its height. The instrument (music box, celesta, glass harmonica, harp, bells,
  thumb piano) comes from its marvel or its way of growing.
- **Every plant has one marvel.** Some glow after dusk, some have petals of glass, and
  some grow an inverted twin of themselves underground in place of roots. Others
  walk slowly across the meadow, or tell the hours.
- **Plants can be crossed.** *Gather pollen* on one plate, turn to another and
  *pollinate* it. That raises a hybrid that is in no plate of the book, and hybrids
  can be crossed again (`#42x977`, `#(42x977)x13`, …).

Keys: `←` `→` turn pages · `R` random plate · `S` song (it keeps playing as you turn
the pages) · `Esc` title page. Click a plate while it is being engraved to finish it
at once.

## How it is made

There are no images, samples or libraries. Everything is drawn, written and played
by plain JavaScript in `docs/`:

| file | what it does |
| --- | --- |
| `js/genome.js` | turns a plate number into a plant: growth habit, stem, leaves, flowers, fruit, roots, colours, marvel and music; also crosses two plants into a hybrid |
| `js/plate.js` | the engraver: paper, plate-mark, ink linework, hatching, watercolour washes, inset figures and lettering, all on Canvas 2D |
| `js/text.js` | the botanist: Latin names, an invented geography, a cast of collectors, descriptions, folklore and song notes |
| `js/song.js` | the composer: a generative piece for each plant, synthesised live with the Web Audio API |
| `js/main.js` | the binding: page turns, cross-pollination, saving plates, and the pollen that rises from the flowers as they sing |

Served as a static site by GitHub Pages from `docs/`. To run it locally:
`cd docs && python3 -m http.server` and open http://localhost:8000.

*A gift from Claude, October 2026.*
