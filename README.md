# Character Registry Tracker (CCT v2)

Solves the "SillyTavern forgets Halfrun is a she after a reboot" problem.
Chat logs survive reboots fine — what's lost is anything that only lived in
the model's context window. This extension keeps a small, structured,
auto-updated fact registry per character, stored in the chat's own metadata
(so it's on disk, not in-context), and injects it into every generation at a
fixed depth — the same mechanism Author's Note uses — so it can't fall out of
context the way a stray line from message #340 can.

Separate from Character Card Tracker (v1). v1 does manual per-character stat
entry for group-chat display; this does automatic fact extraction for
long-term continuity. They can run side by side.

## Install

Copy the `character-registry-tracker` folder into:

```
SillyTavern/public/scripts/extensions/third-party/
```

Restart SillyTavern (or use the extensions manager's "Load from URL/folder"
if you're running from a zip). Enable it from the Extensions panel. A
"Character Registry Tracker" drawer will appear in the extensions settings
sidebar.

## Editing characters mid-chat

A small address-card icon appears in the chat toolbar (next to the send
button area) — click it to open a floating, draggable, resizable window with
the same entity editor as the settings drawer. Both stay in sync; edit from
whichever is more convenient. The window's open/closed state and position
are remembered across sessions.

## Where the registry is stored

Not a separate file — it lives inside the chat's own file, so it survives
reboots without extra bookkeeping. SillyTavern writes `chat_metadata` (the
registry sits under the key `character_registry_tracker`) as the **first
line** of the chat's `.jsonl` file:

```
SillyTavern/data/<your-user-handle>/chats/<CharacterName>/<chat-file-name>.jsonl
```

(or `data/<handle>/group chats/<group-id>.jsonl` for group chats). You can
inspect it directly in a text editor.

## How it works

- **Every field is dynamic by default.** name, sex, pronouns, species, height,
  relationship_to_user, weight, status, key_facts — all of them get freely
  overwritten on each extraction pass, no exceptions, until you decide
  otherwise.
- **Locking is manual and per-field.** Check "lock" on any field to protect
  it. A locked-but-empty field still gets filled normally the first time
  there's data for it — locking doesn't block population, only *drift* once
  a value exists. If a later extraction pass proposes something different
  for a locked field, that goes into "Pending conflicts on locked fields"
  for you to accept or reject, instead of being applied or silently dropped.
- **Extraction**: every N messages (default 30, configurable), a *quiet*
  background generation is sent to the same KoboldCPP connection as your
  main chat — it doesn't appear in the chat log — asking it to return its
  best current understanding of every field it has information for, for
  every character in the recent slice. You can also hit "Rescan now" any
  time.
- **Injection**: whichever entities have "include in context" checked get
  formatted into a compact `[Character Registry]` block and injected at a
  fixed depth (default 4, matching typical Author's Note placement), so it's
  always present regardless of how much the chat has grown or how many times
  you've rebooted.
- **Storage**: the registry lives in the chat's own metadata file (per-chat,
  not global), alongside the chat history itself — no separate database, no
  extra files to lose track of.

## Injection positioning: depth and format

Two separate design questions, answered from research + SillyTavern's own
mechanics rather than guesswork:

**Depth.** LLMs show a well-documented "lost in the middle" U-shaped
attention curve over long context (Liu et al., [arxiv:2307.03172](https://arxiv.org/abs/2307.03172)) — performance is
strongest when relevant info sits at the very start or very end of context,
and drops significantly in the middle. This is mechanically driven by
RoPE's distance-decay: for causal generation, tokens near the end of context
get systematically more attention regardless of content. SillyTavern's own
Author's Note docs confirm the same thing directly: depth 0 = very end of
chat history (strongest influence on the next response), depth 4 = pushed
behind the most recent 3 messages (weaker influence). Author's Note's
*default* of 4 is tuned for general scene-direction notes that don't need
to dominate the next token — this registry is closer to the "always-on
character fact" case the SillyTavern community already places at low depth
for exactly this reason. Default here is **depth 1**, not 4. It's still a
live setting — the true optimum is somewhat model-dependent (different
RoPE bases/finetunes decay differently), so if a particular local model
seems to under- or over-weight the block, adjust it and watch adherence
over a few turns.

**Format.** The injected block was never raw JSON — JSON only exists in the
internal extraction call. What actually lands in the conversation is the
bracketed prose block (`[Character Registry] Halfrun: she/her, human...
[/Character Registry]`), deliberately. Raw JSON sitting inside an ongoing
roleplay context is out-of-distribution for most models mid-narrative —
JSON in training data is overwhelmingly paired with code/API contexts, not
story continuation, so a model is more likely to under-attend to it or
start echoing JSON-like syntax into its own prose. The bracket-tag format
matches how the SillyTavern community already writes this kind of always-on
injected fact (e.g. `[Genre; Tags; Scenario]`), which reads as "world fact"
rather than "text to imitate."

## Fields tracked

**Identity** (name, sex, age, pronouns, species, height, physique) — shown
for every character. "sex" is a fixed two-option dropdown (male/female,
plus unset) rather than free text, since body-detail visibility keys off it
exactly.

**Body detail** (bust, waist, hip) — three separate lockable fields, not one
blob string, so you can lock waist without locking bust. Visibility is fully
automatic and tied to "sex": the section only appears once sex is set to
female, and disappears again if it's changed away from female. There's no
manual override — the extraction prompt is instructed to only propose these
three fields for characters whose sex is female and never invent numbers,
and the merge logic enforces the same rule server-side even if a model
ignores the prompt, so stored data can't drift out of sync with what's ever
shown or injected.

**Story state** (relationship_to_user, weight, status, key_facts) — the
parts of a character expected to actually change over the story.

## Manual add & error codes

- **Add character** button (settings drawer and floating window, above the
  entity list) lets you create an entity by name directly — useful when a
  scan misses someone. It's created empty; fill in fields yourself or wait
  for the next extraction pass.
- Every extraction failure reports a specific code, not just "failed":

  | Code | Meaning |
  |---|---|
  | `NO_CHAT` | No messages in the chat yet to scan |
  | `GENERATION_FAILED` | The quiet background call to your normal connection failed (connection down, model not loaded) |
  | `EMPTY_RESPONSE` | Backend responded but with nothing in it |
  | `NO_JSON` | Model ignored the format instructions entirely |
  | `BAD_JSON` | Model returned JSON-shaped text that doesn't actually parse |
  | `BAD_SHAPE` | Parsed fine but missing the expected `updates` key |
  | `MERGE_FAILED` | Internal bug applying the data — not a model problem |
  | `SAVE_FAILED` | Couldn't write the registry into chat metadata |
  | `GRAMMAR_UNREACHABLE` | Couldn't reach the configured KoboldCPP URL for grammar mode |
  | `GRAMMAR_HTTP_ERROR` | KoboldCPP reached, but rejected the grammar-mode request |

  Each shows in the status line (red, with the code and a concrete next
  step) and logs the same info plus the raw model output to the browser
  console for `NO_JSON`/`BAD_JSON`/`BAD_SHAPE`.

## Reducing extraction failures: grammar-constrained mode

`NO_JSON`, `BAD_JSON`, and `BAD_SHAPE` are all "the model didn't follow the
requested format" failures — the more you rely on the model's own
discipline, the more they happen, especially with smaller local models under
load. There's a real fix for this rather than just tightening the prompt:
**KoboldCPP grammar support** (v1.44+) can constrain generation so it is
*structurally impossible* for the output to be anything other than valid
JSON matching a shape you define — not "usually," but never.

To enable it, fill in **KoboldCPP API URL** in the settings drawer (e.g.
`http://127.0.0.1:5001` — same address you use for your main connection).
When set, extraction bypasses SillyTavern's own generation pipeline and
calls KoboldCPP's native `/api/v1/generate` endpoint directly with a GBNF
grammar that locks the output to exactly `{"updates": {"<name>": {...fields
as valid JSON...}}}`. This is a separate call from your normal chat
generation, so it never affects your roleplay replies — only extraction.

Two extra settings appear alongside it: **max context** and **max response
length** (tokens) for that direct call — defaults (8192 / 512) are generous
enough for most setups, raise "max context" if your extraction window
setting is large and the prompt is getting truncated.

**If you leave the URL blank**, extraction still works via the original
path (through your normal ST connection, no direct call) — but now with one
automatic repair retry: if the first response fails to parse or has the
wrong shape, it gets sent back to the model once with "this wasn't valid
JSON, fix it" before an error code is shown. This reduces failures somewhat
without any setup, but doesn't eliminate them the way grammar mode does.

**Response length is independent of your main chat's setting, on both
paths.** A full JSON registry dump for several characters needs more tokens
than a typical roleplay reply, so if extraction inherited your normal
"Response (tokens)" setting, a short main-chat length (e.g. 600) would
truncate the JSON mid-object — the classic cause of `NO_JSON`/`BAD_JSON`
failures that only go away when you happen to raise your *main* response
length as a side effect. Both paths have their own dedicated setting instead:
"Max response length (tokens)" for grammar mode, "Extraction response
length (tokens, non-grammar path)" for the fallback — raise whichever one
applies to you rather than touching your main chat's length.

## Known risk areas / please report back

I built this against SillyTavern's `release` branch source (fetched
directly, not from memory) for the extension API surface — `getContext()`,
`chatMetadata`/`updateChatMetadata`, `setExtensionPrompt`,
`generateQuietPrompt`, and the event bus — so the plumbing should be
accurate as of now. Two things I couldn't verify without a live instance:

1. **Grammar-mode endpoint assumptions.** I used KoboldCPP's native
   `/api/v1/generate` endpoint (not the OpenAI-compatible one) since that's
   where ST's own code confirms grammar support lives. If your KoboldCPP is
   only exposed via a reverse proxy that blocks that path, or CORS isn't
   permissive for this page's origin, you'll see `GRAMMAR_UNREACHABLE` —
   tell me the exact error and I'll adjust.
2. **Manifest quirks.** If this hits the same ES-module loader issue v1 hit,
   send me the console error and I'll port it to the IIFE + jQuery-event
   pattern the way v1 was fixed.

**Note on the field-schema change**: the registry's per-entity shape changed
(no more separate static/dynamic buckets, locks are now a flat per-field
map). If you'd already been testing against the previous version, any saved
registry data in a chat's metadata is in the old shape and won't be read by
this version — you'll start fresh for chats you'd already run extraction on.
Not an issue for chats you haven't scanned yet.

## Files

- `manifest.json` — extension metadata
- `index.js` — all logic (settings, registry storage, extraction, injection, UI)
- `style.css` — settings panel styling
