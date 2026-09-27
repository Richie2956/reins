# Reins brand

One page. Everything the site, the dashboard, the README and the launch posts share.

## Name

The product is **Reins**. In prose it is 'Reins', capital R, a normal word. Never 'REINS', never 'reins.js', never 'the Reins platform'.

The wordmark is lowercase: **reins**. Set it in the monospace stack, weight 500, with a small accent coloured full stop after it when it stands alone: `reins.` The full stop is the only ornament. The wordmark is for the site header, the dashboard header and the README title. Everywhere else the word is set like any other word.

Package names are what they are: `reins`, `@reins/cli`, `@reins/proxy`, `@reins/adapters`, `@reins/dashboard`. The binary is `reins`.

## Tagline

The control layer for autonomous AI agents.

Use it whole or not at all.

## Tokens

| Token | Light (paper) | Dark (ink) | Used for |
| --- | --- | --- | --- |
| `--paper` | `#f6f4ef` | `#14181d` | Page ground |
| `--ink` | `#14181d` | `#f6f4ef` | Text |
| `--ink-2` | `#4a5058` | `#a9b0b8` | Secondary text, captions |
| `--rule` | `#d9d5cc` | `#2a3038` | Hairlines, table borders |
| `--panel` | `#eeebe4` | `#1c2127` | Code blocks, table headers, raised surfaces |
| `--accent` | `#b5541c` | `#d9884f` | Links, the wordmark's full stop, primary button |
| `--allow` | `#2f6b3c` | `#7fb88a` | Allow verdicts, alive, chain verified |
| `--deny` | `#a63d2f` | `#e08a7a` | Deny verdicts, dead, chain broken |
| `--warn` | `#8a6a1a` | `#d4b25c` | Approval verdicts, low and critical tiers |

Ink and paper swap between themes. Accent, allow, deny and warn each have a light value and a dark value so that text in that colour clears 4.5:1 on its own ground. Do not use the light allow or deny on ink, or the dark ones on paper. Semantic colours (allow, deny, warn) are never used as decoration and the accent is never used to mean allow or deny.

The dark theme is the same page with the tokens swapped. Do not design a second look for it.

## Typography

UI and prose: the system sans stack.

```
-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif
```

Code, the wordmark, tier names, figures in tables and anything that comes from a terminal: the monospace stack.

```
ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace
```

Body 16px at 1.55 line height, running text no wider than 65 characters. Headings in sentence case, weight 600, tight line height. Uppercase labels only for eyebrows and table headers, 12px with 0.06em letter spacing. Tabular figures wherever numbers line up.

## Tone

Plain, specific, short. Write for someone who runs agents and is short of time.

- Say what a thing does, not what it means. 'Denies the call and records the rule' rather than 'gives you confidence'.
- Use numbers. A tier has a threshold in dollars, a limit has a count and a window.
- No dashes as punctuation. Commas, colons and full stops. No semicolon followed by 'and'. Avoid hyphens where a plain word works: 'open source', 'hash chained', 'read only', 'self contained'.
- Single quotes for quoted words in prose.
- No emojis anywhere. Never: seamless, blazing, revolutionary, unlock, supercharge, game changer, empower, robust, leverage.
- Do not oversell. If a thing is not built yet, say 'coming' and stop.
- Agents are 'agents'. The person is 'you'. Reins is 'it'.

## Layout habits

Single column, 1040px maximum, 16px side gutter at every width. Sections divided by a hairline, not a card. Cards only where something is genuinely a separate object (the two products, the two pricing tiers). Tables for anything with more than two columns of fact. Code blocks on the panel colour with no shadow.
