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

## Model-specific tuning

The schema and extraction prompt were trimmed for reliability with
creative-writing-oriented local models — concretely tuned against
[TheDrummer/Artemis-31B-v1.1](https://huggingface.co/TheDrummer/Artemis-31B-v1.1),
a Gemma-4 finetune whose own model card states it deprioritizes
"intelligence, correctness, problem solving" in favor of creativity,
writing quality, and dynamism — and explicitly lists inventing novel
formats as a *desirable* trait. Two consequences drove this pass:

- **Grammar mode matters more than usual here, not less.** A model tuned to
  sometimes deviate from rigid structure in service of prose is exactly the
  case where you want the deviation to be structurally impossible rather
  than discouraged. If you're running a model in this family, turning on
  the KoboldCPP grammar-mode URL (see below) is the single highest-leverage
  reliability setting available — it constrains what tokens can be sampled
  at all, rather than relying on the model's willingness to comply with the
  extraction prompt's rules.
- **Dense numeric/structured content in the injected context is worse than
  usual for this kind of model.** A creativity-tuned model is more likely
  to find a stat block jarring against its own trained prose style than a
  general-purpose instruct model would be. That's the direct reasoning
  behind removing body detail and the body-proportion/movement/feet block
  (see the note under "Fields tracked" below) — both were the densest,
  least narratively-relevant content any character's block could carry.
- **Fewer simultaneous extraction rules, for the same reason "fewer fields"
  helps.** The extraction prompt dropped from 6 to 5 rules for `updates` by
  removing the bust/waist/hip carve-out — one less rule for a model that's
  not optimized for rule-precision to have to hold and correctly apply.

None of this is specific to Artemis by name — it generalizes to any
similarly creativity-first finetune. If you switch to a more
correctness-oriented model later, none of this hurts; it's just not the
tuning direction that model would need.

## Fields tracked

**Identity** (name, sex, age, pronouns, species, height, physique) — shown
for every character. "sex" is a fixed two-option dropdown (male/female,
plus unset); also drives the automatic stencil choice on export (see
"Exporting to the Height Comparison chart").

**Units are enforced on height and weight.** Both are always stored and
injected as `<number>cm` or `<number>kg` — the input box only takes the
number, the unit is a fixed suffix you can't edit. Typing something with no
number in it (or leaving it blank) doesn't get saved; a brief error shows
and the field reverts. The extraction prompt tells the model to convert
imperial units and return a plain number — but the normalizer itself just
extracts the first number it finds, it doesn't do unit conversion. Type the
number in cm/kg directly (e.g. "70" for weight, not "154 lbs") — typing an
imperial value will silently produce a wrong number rather than converting
it.

**Story state** (relationship_to_user, weight, status, key_facts) — the
parts of a character expected to actually change over the story.

> Removed as of the latest pass (see "Model-specific tuning" below): body
> detail (bust/waist/hip) and the auto-computed body-proportion/movement/feet
> guidelines. Both added real injected-token density for information that
> mattered more for literal physical precision than for narrative steering —
> not a good trade for a creative-writing-oriented model. height and weight
> were kept; they're cheap (one number each) and still narratively useful.

## Layout: collapsible sections, built for large rosters

The whole panel (both the settings drawer and the floating window) is
organized into collapsible sections — **Tracked characters**, **Relationships**,
**World notes**, and (settings drawer only) **Settings & connection** —
each with a live count badge in its header so you can gauge how much is in
there without opening it, and a red "⚠ N" badge that appears next to that
count whenever something in it needs a decision (a pending conflict). That
badge stays visible even while the section is collapsed, specifically so a
conflict can never go unnoticed just because you had that section closed.

- **Characters start collapsed.** Every character card loads collapsed to
  just its header — name, an inline summary (sex/age/height plus relationship
  and constraint counts, whichever apply), the include-in-context toggle,
  and delete. Click anywhere on the name/chevron area to expand a single
  one. "Expand all" / "Collapse all" links sit above the list once you have
  more than one character, for scanning or tidying the whole roster at
  once. This is a pure display preference, not data — it isn't saved to the
  chat and resets to all-collapsed on reload.
- **Relationships default collapsed too**, behind their own section — in a
  long campaign the relationship graph can get a lot longer than any single
  character's card, so it's not force-expanded on load the way it used to
  be. The header's `(N)` badge tells you the total count at a glance.
- **Pending conflicts (of either kind) are never shown as empty filler.**
  The "Pending conflicts" heading and list only appear at all once there's
  something in them — otherwise that space just isn't there. Their live
  counts show as the warning badge described above.

## World notes

A freeform text box sits inside its own section in both the settings
drawer and the floating window — for manually maintained facts about the
world itself rather than any character: setting, era, the name of the place
you're in, anything that should stay true regardless of who's currently in
scene. It's completely separate from the character registry: extraction
never reads it, never writes it, never touches it in any way. You write it,
you update it, you decide when it changes.

**Lock** makes the box read-only (a plain accidental-edit guard, not a
conflict-review mechanism like the per-field character locks — there's
nothing to protect it from since nothing auto-updates it). Uncheck to edit,
recheck when you're done.

**Injected separately from the character registry, at a different, higher-
priority position.** Tracked characters are injected at a rolling chat
depth (see "Injection positioning" above) because recency matters for
facts that need to compete with a lot of scrolling narrative. World notes
use `IN_PROMPT` instead — anchored next to the scenario/description in the
assembled prompt rather than scrolling through chat history, so it stays
present with the same weight as core setting information regardless of how
long the chat gets. It's independent of the "Enabled" toggle too, since
that toggle only governs the auto-extracted character registry — world
notes keep injecting even if you've paused that.

## Exporting to the Height Comparison chart

The **"Data-only JSON"** link (settings drawer or floating window, above
the character list) downloads `height-comparison.json` — every tracked
character with a height set, plus an auto-assigned display color. Open the
Height Comparison page and use its own "Import JSON" button. Characters
with no height yet are skipped.

Stencil is picked automatically from `sex`, no manual choice involved: male
always exports as `figure-male`; female gets a random pick each export from
`figure-pose` / `figure-back` / `figure` (varies between exports on
purpose); unset sex falls back to a plain `figure`.

## Critical constraints

**The problem this solves:** a fact can be correctly stored and correctly
injected and still get ignored — e.g. a 50m-tall character still gets
written sleeping in a normal bed or walking through halls, even with the
height tracked accurately and a manual `key_facts` note saying he's too big
for that. That's not a storage bug — the data's there. It's a **salience**
problem: a single passively-worded line sitting among a dozen other facts
in the character blurb doesn't compete well against the model's strong
default narrative habits, especially for a smaller/finetuned model.

**Three things about this field are different from every other field on
purpose, each targeting one part of that problem:**

- **Manual-only, never touched by extraction** (same philosophy as World
  Notes) — so it can't get reworded, diluted, or dropped across passes the
  way `key_facts` can. You write the constraint once, in your own words.
- **Auto-wrapped in explicit, imperative framing at injection time** —
  whatever short phrase you write gets rendered as `MUST NOT be
  contradicted — <Name>: <your text>.`, not stated as a passive fact. You
  don't have to prompt-engineer the phrasing yourself each time.
- **Injected at its own depth, deliberately closer than the character
  registry's own depth** — a separate "Critical constraints depth" setting
  (default 0, the closest possible position) versus the main registry's
  default of 1. The character registry's depth was chosen for facts that
  need to survive being buried by chat length; this is for facts that need
  to win the very next sentence specifically, which is a recency problem
  more than a survival problem, and recency is what depth 0 maximizes.

**Where to find it:** a new "Critical constraints" group in each
character's card, styled distinctly (amber border) so it doesn't blend in
with the ordinary fields around it. Add short, concrete entries — "cannot
fit inside buildings, doorways, or furniture" reads better to a model than
restating the raw height and expecting it to derive the implication itself.
Spelling out the *consequence*, not just the fact, is doing real work here.

**This won't guarantee compliance** — no prompt-engineering technique does,
especially against a small model's strong learned priors. It stacks the
deck as far as data modeling and injection design can: distinct framing,
protected from dilution, positioned for maximum next-token influence. If a
specific constraint still gets violated often, the next lever to pull is
usually the model itself (a larger model, or a finetune that's actually
seen "must never" style constraints honored during training) rather than
anything else this extension can do structurally.

## Relationships between characters

**The problem this solves:** `relationship_to_user` works reliably because
there's only ever one other party — the user — so a single string per
character never contradicts itself. A relationship *between two tracked
characters* has no such guarantee. Before this, the only place for that kind
of fact was `key_facts`, a free-text array that gets wholesale-replaced
(not merged) on every extraction pass — so "Halfrun's child: Runa" on one
card and "Runa's parent: Halfrun" on another could silently drift apart
across passes, or get dropped and reworded differently each time. That's
the actual mechanism behind parents and children getting mixed up, not
carelessness on the model's part — the data model just had nowhere reliable
to put the fact.

**The fix: one shared fact per relationship, not two copies.** Relationships
live in their own collapsible section, separate from every character's own
fields. Each relationship is stored exactly once — both directions ("Halfrun is
Runa's parent" / "Runa is Halfrun's child") are generated from that single
record when injected, so there is nothing for two sides to disagree about,
because there's only one side.

**A small, fixed vocabulary, deliberately — this is the part aimed at
smaller/finetuned models.** Every relationship has a `type`: `parent_child`,
`spouse`, `sibling`, or `other` (with a short freeform label, for anything
else — mentor, rival, employer, friend). `parent_child` uses explicit
`parent`/`child` role names rather than a generic, order-dependent pair —
a model doesn't have to be trusted to consistently pick which side goes
first, the field name itself carries the meaning. A bounded, named choice
like this is far more reliable for a model to emit correctly and for the
extension to parse and act on than open-ended prose ever could be, and it's
also easier for a small/finetuned model reading the injected text to latch
onto, since the same handful of sentence shapes recur verbatim rather than
being reworded freely each time.

**Locking now protects against a NEW, contradicting fact too, not just an
edited one.** For `parent_child` and `spouse` specifically — the two types
where a second, different answer is usually a sign something got mixed up
rather than a normal multiplicity — locking a relationship also blocks a
*different*, newly-proposed edge from silently sneaking in alongside it
(e.g. a second "parent" appearing for the same child from a later
extraction pass). That kind of contradiction goes to a dedicated "Pending
relationship conflicts" queue instead, exactly like a locked field
conflict, where you can accept the correction (replacing the old edge) or
reject it (keep what was there). `sibling` and `other` aren't restricted
this way, since having several is normal for those rather than a sign of
an error.

**Manual add**: a form below the relationship list, with two dropdowns
(populated from currently tracked characters — no typing a name, so no way
to mistype or mis-case one) that relabel their placeholder to
"Parent"/"Child" when you pick that type. Manual entry always wins
outright, the same way typing directly into a character's field does —
locks only guard against extraction's own guesses, never against something
you picked yourself.

**Injected as its own block, right after the Character Registry block, at
the same position and depth.** Relationships involving a character whose
"include in context" is unchecked are left out, matching how that toggle
already works for character data.

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
