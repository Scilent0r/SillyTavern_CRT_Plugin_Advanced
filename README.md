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

## How it works

- **Static fields** (name, sex, pronouns, species, height): filled once,
  locked by default. The extractor will never overwrite one on its own — if
  the chat contradicts it, the change goes into "Pending static-field
  conflicts" for you to accept or reject by hand.
- **Dynamic fields** (relationship_to_user, weight, status, key_facts):
  refreshed on every extraction pass, unless you lock an individual field.
- **Extraction**: every N messages (default 30, configurable), a *quiet*
  background generation is sent to the same KoboldCPP connection as your
  main chat — it doesn't appear in the chat log — asking it to return a
  small JSON diff of what changed. You can also hit "Rescan now" any time.
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

## Files

- `manifest.json` — extension metadata
- `index.js` — all logic (settings, registry storage, extraction, injection, UI)
- `style.css` — settings panel styling
