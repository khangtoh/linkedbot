# Product

## Register

product

## Users

One person: the owner of a LinkedIn account who runs linkedbot for themselves. They open the studio
from a phone as often as from a desktop, usually in short sessions between other work: to log the bot
in to LinkedIn, to check what ran, to turn a sequence they keep repeating into a tool, or to ask for an
API that does not exist yet. The same operations are also used by AI assistants (Claude, ChatGPT,
Cursor and others) over MCP, so the studio is where the owner shapes what those assistants can do.

They are capable but not necessarily a programmer, and they are spending a scarce resource (daily
LinkedIn page loads on their own account) every time something runs.

## Product Purpose

The studio is where the owner builds and looks after their LinkedIn tools without writing code:

- compose new MCP tools by chaining existing operations, seeing real data flow between the steps;
- generate a missing API by describing it, watching the generator work in a live browser, and
  correcting it by pointing at the page;
- run anything, read results and leads, and see what is queued or paused.

Success: a tool or API goes from idea to published in a few minutes on a phone, the owner always
knows what a run will cost before it runs, and nothing surprising ever happens to their account.

## Brand Personality

Warm, guided, friendly. It explains itself in plain language at the moment it matters, offers the
next sensible step, and never makes the owner feel they broke something. Confident about safety
(read-only, caps, the pause on a login wall) without being alarming. Familiar where familiarity
helps: the step-stack feel of Apple Shortcuts, the quiet precision and polish of Linear.

## Anti-references

- LinkedIn's own look: no LinkedIn blue-and-white styling. This is the owner's tool, not a LinkedIn page.
- The generic SaaS dashboard: card grids, big-number stat tiles, gradient accents.
- Node-graph canvases with wires (n8n style); the studio uses a vertical step stack.

## Design Principles

1. **Show the real thing.** Previews are real runs on real data, so what you build is what you get.
2. **Spend is always visible.** Every action that touches LinkedIn says what it will cost and what is left today, before it runs.
3. **Guide, don't gate.** Offer the next step and explain problems where they happen, in words, instead of blocking with errors.
4. **One-handed first.** Every journey works on a phone with a thumb; the desktop gets more room, not more features.
5. **Calm about safety.** Read-only, caps and the login-wall pause are reassurances, stated plainly, never alarms.

## Accessibility & Inclusion

WCAG 2.2 AA: text contrast, full keyboard use on desktop, screen-reader labels for every control and
for the live browser view, visible focus, touch targets of at least 44px, and reduced-motion support.
