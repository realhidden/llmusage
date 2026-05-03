# UI

Popup window. Frameless, fixed width 360px, height clamped 480–640px (scroll inside if more). Anchored under the tray icon.

## Header (sticky, 36px)

```
[● Claude]   [today: 1.2M tok]   [⚠ 2 waiting]   [⚙]
```

- `●` color: green if any session `running`; amber if any `waiting-for-input`; gray otherwise.
- `today` is `today.tokens.total` formatted via `Intl.NumberFormat` with `notation: "compact"`.
- `⚠ N waiting` only renders when `sessions.active.filter(s => s.state === "waiting-for-input").length > 0`. Click → scroll to Sessions panel.
- `⚙` opens config panel (Phase 4).

## Section 1 — Today

```
TODAY                     2026-05-03
┌────────────────────────────────────┐
│ input    ████░░░░░░  120k          │
│ output   ███░░░░░░░   85k          │
│ cache↑   ██░░░░░░░░   40k          │
│ cache↓   ██████████  900k          │
└────────────────────────────────────┘
5h window:    62% of 200k    [██████░░░░]
weekly:       18% of 2.0M    [██░░░░░░░░]

By model:
  opus-4-7      640k
  sonnet-4-6    280k
  haiku-4-5      80k
```

- Limit bars only render when `config.limits.*Tokens` is set; otherwise hide that line entirely.
- Bar fill color: green <70%, amber 70–90%, red ≥90%.

## Section 2 — Last 7 days

```
LAST 7 DAYS
   ▁ ▃ ▅ ▂ █ ▆ ▄
   Sa Su Mo Tu We Th Fr
```

- Each bar represents `last7Days[i].bucket.tokens.total`.
- Stacked sub-bars by model (top = opus, etc.) — colors consistent with Today panel legend.
- Day label = first two letters of localized weekday.
- Hover/click on a bar → tooltip with date + per-model breakdown.

## Section 3 — Sessions

```
ACTIVE
[●] mystatus  master                  ◉ running
    opus-4-7  · 12 turns · 320k tok
    last: "Plan out everything, write…"

[⚠] myproject  feature/llm   ◉ waiting
    opus-4-7  · 47 turns · 1.1M tok
    last: "I've reviewed the diff, want me…"

RECENT
○ done-dmsone           main           done · 2h ago
○ Projects                             idle · 5h ago
○ Downloads/picoclaw    -              done · 1d ago
…
```

Per row:

- Left dot: green/amber/gray per state.
- Title = basename of `cwd`. Subtitle = `gitBranch` (or `-` if empty).
- Right: state badge.
- Second line: model(s) joined by `, ` if multiple, then assistant turn count, then total tokens (compact).
- Third line: `last` = `lastPrompt` (truncated to 60 chars + ellipsis). Empty if null.

### Row click → expand

```
[⚠] myproject  feature/llm   ◉ waiting
    cwd: /Users/you/Projects/myproject
    started: 2026-05-01 22:01    last: 22:11 (3m ago)

    Tokens
      input          12.4k
      output         18.7k
      cache create   180k
      cache read     920k

    Models
      opus-4-7        920k cache↓ + 200k input/output
      haiku-4-5         8k

    [Open in Finder]   [Copy session id]
```

## States and empty cases

- Cold start (still scanning): show skeleton bars + `loading…` in header.
- No data at all: friendly empty state with the path it watches.
- Error: red banner with last error message and a `retry` button (calls `store:snapshot`).

## Visual language

- Mac-native feel: SF Symbols-style monochrome glyphs (inline SVG), system font (`-apple-system`).
- Light / dark via `prefers-color-scheme`. Tray icon is a `*Template.png` for auto-tint.
- Spacing scale: 4 / 8 / 12 / 16. No third-party UI library.

## Live update behavior

- On `store:update`, diff the `StoreSnapshot` against last render; only re-render panels whose slice changed (compare by `generatedAt` per slice, or by deep-equal of the slice).
- Animations: bar widths animate via CSS transition (200ms). Row state-badge changes pulse once.
