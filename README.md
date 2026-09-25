# Strange Loop

*a homage to M. C. Escher*

**[▶ Play it in your browser](https://amberxplorer.github.io/opus5.5-escher/)**

A ninety-second audiovisual piece in black and white, built as one continuous metamorphosis.
It ends on the frame it began with. Every picture is drawn in the browser as it plays, and
every sound is synthesized there from the score in `src/synth.js`.

Open `index.html` in a browser with WebGL 2 (any current Chrome, Edge, Firefox or Safari),
then click, tap or press Enter. Headphones help.

| key | does |
| --- | --- |
| Enter / click | play (and play again after the end) |
| Space | pause / resume |
| F | fullscreen |
| ← / → | seek 5 s |
| R | restart |

## What happens

| time | picture | music (6/8, 48 bars) |
| --- | --- | --- |
| 0:00 | the title, lettered on a square grid; the letters turn into a checkerboard (after *Metamorphosis II*) | organ chord, bells, then the harpsichord in D minor |
| 0:07 | the checkerboard's edges bend and the squares become birds, black and white, all flying the same way (Escher's own method of dividing the plane) | the subject enters on the organ |
| 0:15 | sky turns to water: birds become fish as we sink; on bar 12 day turns to night and every fish turns round | E major; the drums start. On bar 12 the melody is played upside down, in E minor |
| 0:28 | the plane goes solid: the black squares rise as engraved cubes while the camera swings to isometric | the build |
| 0:30 | nine cubes fly into Reutersvärd's impossible triangle (1934), which fuses into Penrose's tribar (1958); the camera circles to show it is really a bent bar, and snaps back as it closes | F♯ minor, the first drop; a held breath while the camera circles |
| 0:39 | the tribar comes apart into the endless stairs (Penrose, 1959; Escher's *Ascending and Descending*, 1960); hooded figures climb one step per beat | footsteps, and an arpeggio that rises for ever |
| 0:45 | the steps let go, close into a ring and take half a twist: a Möbius strip with ants on its one side (*Möbius Strip II*) | A♭ major; the subject against itself backwards, a crab canon |
| 1:00 | the ring becomes the edge of the Poincaré disk: a {6,4} tiling of interlocking pinwheels in the manner of *Circle Limit* | B♭ minor, the climax: the subject at three speeds at once; figure and ground swap on bars 34, 36 and 38 |
| 1:15 | the birds again, carried through the complex logarithm into a spiral that zooms for ever (*Print Gallery*, *Path of Life*) | C minor; a Risset rhythm that speeds up for ever and never gets faster |
| 1:23 | the birds become squares; the blank at the centre (where Escher signed *Print Gallery*) grows until it is the title card | the harpsichord and organ alone, back to D minor on the last chord |

## The loop in the music

The score is a passacaglia *per tonos*. Its eight-bar ground walks down the scale bar by bar,
from the tonic down a seventh, and so lands a whole tone *above* where it started. Six
sections in six keys (D, E, F♯, G♯, A♯, C) climb an octave. The organ, the bass and the
harpsichord are voiced as octave stacks under a fixed spectral window (Shepard tones), so
the climb is heard but never arrives: after ninety seconds the music is exactly where it
began. It is Bach's endlessly rising canon from the *Musical Offering*, the one Hofstadter
set beside Escher's stairs. The melody is transformed the way Escher transforms a tile:
translated (canon), reflected (inversion), rotated in time (crab canon) and scaled
(augmentation and diminution).

## How it works

- **Sound** (`src/synth.js`). A sample-level synthesizer renders the whole track in a Web
  Worker while the title card is up. The harpsichord is Karplus–Strong strings in three
  registers; the organ, bass and lead are Shepard stacks; there are FM bells, clockwork
  ticks, synthesized drums, a Shepard–Risset glissando, a Dattorro plate reverb and a
  look-ahead limiter. It returns per-instrument envelopes and the score, so the picture
  moves with the actual notes.
- **Tessellations** (`src/tiles.js`). A checkerboard whose four kinds of edge are replaced
  by curves. Black and white tiles trade exactly what one gains and the other loses, and
  each edge morphs between designs by where it sits, which is how the birds become fish.
- **Plates** (`src/gfx.js`). Everything is ink on paper. A Canvas2D plate for vector work, a
  WebGL plate for meshes shaded as engraving (hatch lines that follow each face, crossing
  in the shadows), and full-screen shader plates for the hyperbolic tiling and the
  logarithmic spiral. A final pass stacks them and can swap paper and ink.
- **Impossible figures** (`src/scenes.js`). The triangle and the stairs are real 3D objects
  whose gap points straight at an orthographic camera. The triangle's near end is carved
  wherever its far end lies behind it, and the stairs' gap is (4, 4, 7.2) along a 51.8°
  view, so nothing needs cutting.
- **Timeline** (`src/scenes.js`). Every frame is a pure function of the music clock, read
  from the audio output timestamp, so picture and sound stay locked and seeking works.

## Building and checking

`index.html` is generated; edit `src/` and run `node build.mjs`.

- `node tools/audio.mjs [dir]` renders the track in Node, writes `track.wav` and
  `spectrogram.png`, and prints levels per section and per instrument.
- `node tools/shoot.mjs <dir> 1280x720 12.5,33,80 [fontDir]` captures frames headlessly
  (`sheet:` in front of the times makes a contact sheet).
- `node tools/video.mjs out.mp4 track.wav 720x1280 30 [fontDir]` renders an MP4 frame by
  frame (one second of the title card, then the whole piece), muxed with the WAV from
  `tools/audio.mjs`.
- `node tools/play.mjs <seconds> [startAt] [fontDir]` plays the page for real in headless
  Chromium and reports the clock, frame rate and any console errors.

The subtitle is set in Cormorant Garamond from Google Fonts; without a network connection
the page falls back to a local serif. The title lettering is drawn on the grid and needs no
font.
