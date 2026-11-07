# Edition: the look of Home and About

Each release can bring its own look for Home and the About box. Everything that
belongs to the look lives in this folder, so a new edition is a matter of
replacing these files. Nothing else in the app has to change.

**Current edition: 1.3, "Ribbon".** Home has a pearly sheen. About shows a
flowing ribbon wave (rainbow on white in light, neon sunset on near-black in
dark), with the details on frosted glass.

## Files

| File               | What it is                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `about-light.webp` | About picture for the light theme                                                                                                                    |
| `about-dark.webp`  | About picture for the dark theme                                                                                                                     |
| `edition.css`      | The colours: Home's page, sheen and light-theme cards, plus About's background, glass and text colours (`--home-*`, `--about-*`), for light and dark |
| `index.ts`         | Imports the two pictures for the About box (only touch it to rename them)                                                                            |

## Making the next edition

1. **Pictures:** 1600 px wide WebP, quality about 85, at most about 250 KB each
   (1.3's are 94 KB and 123 KB). The dialog is 620 px wide and shows the picture
   across the top, at its full width. The top 168 px stay clear; the glass panel
   covers the rest. So keep the subject in the upper part, keep the top-right
   corner quiet (the close button sits there), and use no text and no logos.
   Make one for light (a pale background) and one for dark (a near-black
   background).
2. **`--about-bg`:** the colour at the pictures' edges, so the dialog continues
   them below the picture (1.3: `#fefefe` and `#090517`).
3. **Glass and text:** `--about-glass` and `--about-text*` / `--about-link`. Every
   text on the glass must reach 4.5:1 against what is behind it, picture
   included.
4. **Home:** `--home-bg` and `--home-sheen` (page and sheen), plus the light
   theme's cards (`--home-card-*`). In dark, keep the card tokens pointing at the
   app's own card colours (`var(--surface)`, `var(--card-shadow)`,
   `var(--border-strong)`), so the cards stay as they are everywhere else.
5. **Check:** run `node desktop/bench/check-edition.mjs` (after
   `npm run build:web`). It opens Home and About in light and dark and checks
   that the pictures load, that the glass panel has no border, that the dark
   cards are the app's own, and that the text contrast is at least 4.5:1,
   measured on the rendered pixels. It saves screenshots for review.
