# Character Registry Tracker

**Stop your characters from forgetting who they are.**

If you've ever restarted KoboldCPP or reloaded SillyTavern and come back to find your characters' ages, relationships, or basic facts have quietly drifted or vanished — this fixes that.

## The problem

Long roleplay chats lose track of details. A character's info, who's married to whom, that one character is the other's boss or wife — none of that lives anywhere durable. It's only as "remembered" as whatever happens to still be inside the model's context window. Reboot the backend, hit a context limit, or just have a long enough conversation, and facts get overwritten, contradicted, or dropped entirely.

**Character Registry Tracker** fixes this by keeping a small, structured fact sheet for every character, stored directly in the chat itself (not a separate file), and force-feeding that fact sheet into every single generation — no matter how long the conversation gets or how many times you restart your backend.

## How is this different from MemoryBooks?

They solve different problems and work well together:

- **MemoryBooks** watches your conversation and writes *event/plot summaries* — "what happened" — into keyword-triggered lorebook entries. Great for long-term plot memory, but it only surfaces when a keyword matches, and it needs a Chat Completion–style API.
- **Character Registry Tracker** tracks *entity state* — "who is who, right now" — and injects it into **every** message, unconditionally. No keywords, no triggers, no Chat Completion requirement. It works over plain KoboldCPP text completion.

Use MemoryBooks for "what happened three chapters ago." Use this for "does the model still know my character is an elf and has a halfling son called Halfrun."

## What it does

- Automatically scans recent messages and extracts character facts (name, age, sex, species, height, weight, relationship to you, and more) using a quiet background AI call — nothing shows up in your chat log.
- Injects those facts into every generation at a position tuned to stay in the model's strongest-attention zone, so they actually get used, not just stored.
- Locks facts you don't want overwritten (a character's name shouldn't change because the model hallucinated for one message).
- Tracks relationships *between* characters (not just to you) as a single shared source of truth, so your three kids don't end up with mixed-up parents halfway through the story.
- Lets you write permanent "Critical Constraints" per character — hard rules like "is 50 meters tall, does not fit in normal furniture" — for facts that keep getting narratively ignored even though they're stored correctly.
- Gives you a freeform "World Notes" box for setting/era/location facts that have nothing to do with any one character.
- All of it lives in your chat's own save file. Nothing external, nothing that gets left behind when you switch chats.

## Install

1. Copy the `character-registry-tracker` folder into your SillyTavern `extensions` folder.
2. Reload SillyTavern (or use the extension manager's reload).
3. Look for **Character Registry** in your extensions list, and a new toolbar button to open its panel.

## Using it

- The panel shows every character it's tracking, with their current known facts.
- Click a field's lock icon to freeze it — the extractor will never change a locked field again.
- Add characters manually if you want to track someone before they're mentioned enough to get auto-detected.
- Use **Rescan now** any time to trigger an extraction pass immediately instead of waiting for the automatic timer.
- Toggle **Exclude from extraction** on a character to keep them permanently as-is (useful for background/minor characters you don't want the AI silently editing).
- Add **Critical Constraints** for any fact that keeps getting ignored in the actual prose even though it's stored correctly.
- Use **World Notes** for anything that isn't about a specific character — location, time period, current situation.
- If a new extraction would contradict a locked fact or an existing relationship, it goes into a **Pending Conflicts** queue instead of silently overwriting anything — you approve or reject the change yourself.

## Optional: more reliable extraction with KoboldCPP grammar mode

If you're running KoboldCPP directly, you can point the extension at its API URL in settings. This uses KoboldCPP's grammar-constrained generation to *guarantee* the extraction output is valid JSON, which cuts down on parse failures significantly — especially with smaller or heavily creativity-tuned models. This is optional; the extension works without it, just with a slightly higher chance of an extraction pass failing to parse (it'll just retry next time).

## A note on model choice

This was built and tuned against a 31B creative-writing finetune, and stayed roughly 80–90% accurate across 2000+ message conversations. Smaller or more heavily "creative-over-correct" tuned models will drift more; if you're seeing frequent extraction failures, try enabling grammar mode above, or shortening how many messages get sent per extraction pass in settings.

## Files

- `index.js` — the extension logic
- `style.css` — panel styling
- `manifest.json` — SillyTavern extension metadata

# Settings
<img width="638" height="1091" alt="kuva" src="https://github.com/user-attachments/assets/d5db336a-a12b-47dd-8cfb-bcf7ad578ad5" />
I run the plugin with the following settings. Extraction response length has to be long enough that the json is not cut and thus cause extraction failures for invalid json.
