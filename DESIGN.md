# Design

The linkedbot studio's visual system. Product register (see PRODUCT.md): the interface serves the
task, earns trust through familiarity, and saves personality for copy and a few moments.

## Visual theme

Warm, guided, friendly, on quiet surfaces. Warm-tinted neutrals carry almost everything; one accent,
chosen by the owner in Settings, marks actions, the current selection and data chips. Light and dark
themes are designed together and follow the device setting. Structure comes from a vertical stack of
step blocks (Apple Shortcuts) with Linear's restraint: thin lines, generous spacing, no decoration.

Scene: one person checking their LinkedIn tools on a phone between other things, in whatever light
they are in, so both themes are first-class.

## Colour

All colours are OKLCH. Neutrals are tinted toward hue 55 (warm); chroma falls toward the extremes.
Never pure black or white.

| Role | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `oklch(97.8% 0.006 60)` | `oklch(18.5% 0.010 50)` | Page background |
| `--surface` | `oklch(99.3% 0.004 60)` | `oklch(22% 0.012 50)` | Step blocks, inputs, sheets |
| `--surface-2` | `oklch(95.5% 0.009 60)` | `oklch(26% 0.014 50)` | Bars, rail, nested loop body, hover |
| `--line` | `oklch(88.5% 0.010 60)` | `oklch(34% 0.014 50)` | Borders and dividers (1px) |
| `--text` | `oklch(25% 0.015 50)` | `oklch(94% 0.008 60)` | Body and headings |
| `--text-2` | `oklch(45% 0.015 50)` | `oklch(77% 0.012 60)` | Secondary text, labels |
| `--text-3` | `oklch(56% 0.012 50)` | `oklch(64% 0.012 60)` | Placeholders, disabled (never for essential text) |

Accent sets (`data-accent` on `<html>`; terracotta by default). Each defines `--accent` (fills),
`--on-accent` (text on fills), `--accent-text` (accent-coloured text and icons on surfaces) and
`--accent-soft` (chip and selection backgrounds).

| Accent | Light `--accent` / `--on-accent` / `--accent-text` / `--accent-soft` | Dark `--accent` / `--on-accent` / `--accent-text` / `--accent-soft` |
|---|---|---|
| terracotta (hue 40) | `56% .14 40` / `98.5% .01 60` / `50% .13 40` / `93.5% .035 45` | `72% .12 40` / `20% .03 40` / `78% .10 40` / `33% .05 40` |
| amber (hue 70) | `66% .14 68` / `22% .04 60` / `50% .11 65` / `94% .045 80` | `80% .13 78` / `21% .03 60` / `84% .11 80` / `34% .05 70` |
| sage (hue 150) | `50% .08 150` / `98.5% .01 150` / `45% .08 150` / `93.5% .03 150` | `75% .08 150` / `20% .02 150` / `80% .07 150` / `32% .04 150` |
| plum (hue 330) | `48% .12 330` / `98.5% .01 330` / `45% .12 330` / `94% .03 330` | `75% .10 330` / `20% .03 330` / `81% .08 330` / `33% .05 330` |

Semantic colours (independent of the accent; always paired with an icon or word, never colour alone):
`--ok` (hue 150), `--warn` (hue 75), `--danger` (hue 28), each with a `-soft` background. Contrast:
text roles meet 4.5:1 on `--bg`, `--surface` and `--surface-2`; `--on-accent` meets 4.5:1 on
`--accent`; non-text indicators meet 3:1. `scripts/contrast.mjs` checks every pair.

## Typography

One family: the system UI stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`), with
`ui-monospace` only for expressions and JSON. Fixed rem scale, ratio about 1.2, body 16px (also keeps
iOS from zooming into inputs).

| Token | Size | Weight | Use |
|---|---|---|---|
| `--t-title` | 1.5rem / 1.25 | 650 | Screen titles |
| `--t-heading` | 1.1875rem / 1.3 | 620 | Section and sheet headings |
| `--t-body` | 1rem / 1.5 | 400 | Body, inputs |
| `--t-label` | 0.875rem / 1.4 | 560 | Labels, buttons, chips |
| `--t-small` | 0.8125rem / 1.4 | 450 | Hints, costs, timestamps |

Prose is capped at 68ch. Numbers that change (costs, counts) use tabular figures.

## Space, shape, elevation

Spacing on a 4px base: 4, 8, 12, 16, 24, 32, 48. Vary it: tight inside a block, roomy between blocks.
Radii: 8px small controls, 12px inputs and buttons, 16px step blocks and sheets, full for chips and
pills. One elevation, for sheets and menus only: `0 8px 32px oklch(20% .02 50 / .18)`. Everything else
is flat with 1px lines. No nested cards: a loop's inner steps sit on `--surface-2` inside the block,
without their own shadow.

## Layout

- Phone (under 768px): top bar (screen title, LinkedIn status pill, today's page loads), content,
  bottom tab bar with five destinations (Library, Build, Generate, Activity, Settings), 44px targets.
- Desktop (768px and up): left rail with the same five destinations; builders split into the step
  stack (max 34rem) and a preview pane that fills the rest.
- 16px side gutters on phones, no horizontal page scroll.

## Components

- **Button**: primary (accent fill), secondary (surface with line), quiet (text only), danger. 44px
  tall on touch. Loading shows a small spinner inside, keeping the width.
- **Status pill**: LinkedIn state (Connected, Needs login, Login in progress, Paused) with icon + word.
- **Step block**: number, operation name, one-line description, then its inputs as rows; actions
  (move up, move down, disable, remove) in a compact row; "Run to here" at the bottom.
- **Loop block**: "For each <item> in <list>, up to <n>" header, inner steps on `--surface-2`.
- **Data chip**: accent-soft pill with a small link icon naming the data it carries
  ("found › sample", "person › url"). Tapping a field in a preview inserts one.
- **Field**: label, control, hint; errors below in `--danger` with an icon, linked by aria-describedby.
- **Bottom sheet** (phone): two heights (peek 30%, full 85%), drag handle, also a button to toggle.
- **Cost note**: "Uses up to 1 search + 5 profile views · 34 profile views left today".
- **Empty state**: one sentence of what goes here and the one action to start.
- **Skeleton**: line placeholders while loading; no spinners in the middle of content.

## Motion

150 to 220ms, ease-out-quart (`cubic-bezier(.25,1,.5,1)`), only for state: sheets opening, a new step
appearing, a chip being inserted. No bounce, no page-load choreography. `prefers-reduced-motion`
turns all of it into instant changes.

## Do and don't

- Do say what a run will spend before it spends it.
- Do explain errors in place, with the next step.
- Don't use LinkedIn blue, gradients, glass, card grids or big-number tiles.
- Don't use colour as the only signal, or side-stripe borders as accents.
- Don't use em dashes in copy.
