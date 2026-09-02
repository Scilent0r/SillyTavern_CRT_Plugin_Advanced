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

## Known risk areas / please report back

I built this against SillyTavern's `release` branch source (fetched
directly, not from memory) for the extension API surface — `getContext()`,
`chatMetadata`/`updateChatMetadata`, `setExtensionPrompt`,
`generateQuietPrompt`, and the event bus — so the plumbing should be
accurate as of now. Two things I couldn't verify without a live instance:

1. **Extraction JSON reliability.** Some backends/models are sloppy about
   returning clean JSON even when asked. The parser strips code fences and
   grabs the first `{...}` block, but a badly-formatted response will just
   fail extraction silently (check the browser console — it logs the error).
   If this happens a lot with your model, tell me and I'll add a stricter
   grammar constraint via KoboldCPP's JSON schema support instead of relying
   on prompt instructions alone.
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
