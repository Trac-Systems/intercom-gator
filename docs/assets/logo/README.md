# intercom-gator mark

A gator head drawn in the key-print grammar used by the avatars:
- quarter discs: eye ridge, nostril knob, snout, chin
- slit lens: the eye
- 45° chamfers: the teeth and the tag's cut corner
- two tones on a ground

The drawing uses a 32-unit grid, so horizontal edges land on whole pixels at 16 and 32 px. The eye and the gaps
between the jaws are real holes, so every mark also works in one colour.

| Direction | Colour | One colour | Idea |
|---|---|---|---|
| **Bite** (in use) | `gator-bite.svg` | `gator-bite-mono.svg` | closed jaw: tooth zig-zag, eye ridge, nostril knob |
| Lurker | `gator-lurker.svg` | `gator-lurker-mono.svg` | eye ridge and nostril knob above the waterline |
| Clip | `gator-clip.svg` | `gator-clip-mono.svg` | open jaws, also the alligator clip (a connector) |

Each colour file switches palette with `prefers-color-scheme`. The mono files use `currentColor`.
`gator-readme.svg` and `gator-readme-dark.svg` are Bite with fixed palettes, for the `<picture>` header in the root README.

Palette (hex values of the dashboard tokens):

| | ground `g` | upper jaw `a` | lower jaw / water `b` |
|---|---|---|---|
| light | `#eae7ff` (acc-soft) | `#6a35d9` (acc) | `#9e90e7` |
| dark | `#2f264e` | `#a88fff` | `#7d6abf` |

The same mark appears in several places:
- `packages/dashboard/public/js/lib/keyprint.js` (`BRAND`, drawn by `brandSVG`)
- `packages/dashboard/public/favicon.svg`
- `favicon-32.png` and `apple-touch-icon.png`, rendered from it; the touch icon is a full square because iOS rounds
  the corners

To switch direction:
1. Copy the `a`/`b` paths into `BRAND`. Clip also needs its `transform` on the `a` path.
2. Replace the paths in `favicon.svg` and in the two README files.
3. Render the two PNGs again.
