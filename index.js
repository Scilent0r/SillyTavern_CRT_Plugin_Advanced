// Character Registry Tracker (CCT v2)
// Auto-maintained per-character fact registry that survives KoboldCPP/SillyTavern
// reboots by living in chat metadata (saved to disk with the chat) instead of
// relying on the model's context window or hand-authored World Info entries.
//
// Every field is dynamic (freely overwritten on each extraction pass) unless
// you manually lock it. Locking a field doesn't stop it from ever being
// filled — it just means a later proposal that DISAGREES with the current
// value gets queued as a conflict for you to accept/reject, instead of being
// applied silently or blocked silently.
//
// See README.md for the full design rationale.

import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, extension_prompt_roles, extension_prompt_types } from '../../../../script.js';

const MODULE_NAME = 'character_registry_tracker';
const EXT_PROMPT_KEY = 'CRT_REGISTRY_BLOCK';
const WORLD_NOTES_PROMPT_KEY = 'CRT_WORLD_NOTES_BLOCK';
const CRITICAL_FACTS_PROMPT_KEY = 'CRT_CRITICAL_FACTS_BLOCK';

// In-memory only (not persisted) — which entities are EXPANDED in the UI.
// Opt-in (rather than opt-out/collapsedEntityNames) so every character,
// old or newly added, defaults to collapsed — the sensible default once a
// roster gets past a couple of characters. Purely a display preference, not
// data, so it doesn't need to survive a page reload the way locks/fields do.
const expandedEntityNames = new Set();

// Purely cosmetic grouping for the UI.
const IDENTITY_FIELDS = ['name', 'sex', 'age', 'pronouns', 'species', 'height', 'physique'];
const STATE_FIELDS = ['relationship_to_user', 'weight', 'status', 'key_facts'];
const ALL_FIELDS = [...IDENTITY_FIELDS, ...STATE_FIELDS];
const ARRAY_FIELDS = ['key_facts'];
const SEX_OPTIONS = ['', 'male', 'female']; // '' = unset

// Stencil for the standalone Height Comparison export is fully automatic
// (sex-based, see pickStencilForExport) — no per-character manual override.
const DEFAULT_STENCIL = 'figure'; // fallback when sex isn't set

// Cycled deterministically by export order so entries land on distinct
// colors without needing a color picker in this UI.
const EXPORT_COLOR_PALETTE = ['#2E5C8A', '#B5502F', '#3E7A4C', '#C79A2E', '#6B4E8A', '#5B6B7B', '#1D3E5C', '#8A2E4E'];

// ---------------------------------------------------------------------------
// Inter-character relationships — a shared graph, not a per-character field.
//
// Why: relationship_to_user works fine because there's only ever one "other
// party" (the user), so a single string field per character never
// contradicts itself. Relationships BETWEEN tracked characters have no such
// guarantee — two independent free-text facts ("Halfrun's child: Runa" on
// one card, "Runa's parent: Halfrun" on another) can drift apart across
// extraction passes, and previously the only place for this kind of fact was
// key_facts, an array that gets wholesale-replaced (not merged) every pass.
// That's the actual mechanism behind parents/children getting mixed up.
//
// Fix: one canonical edge per relationship, stored once at the registry
// level (not owned by either character), with a fixed small vocabulary of
// types so a small/finetuned model has an unambiguous, bounded choice rather
// than open-ended prose. Both directions are derived from the SAME edge at
// render time — there is nothing for two copies to disagree about, because
// there's only ever one copy. A canonical dedup key means re-extracting the
// same real-world fact updates the one existing edge instead of spawning a
// contradictory duplicate.
// ---------------------------------------------------------------------------

const RELATIONSHIP_TYPES = ['parent_child', 'spouse', 'sibling', 'other'];
const RELATIONSHIP_TYPE_LABELS = {
    parent_child: 'Parent / Child',
    spouse: 'Spouse',
    sibling: 'Sibling',
    other: 'Other (custom label)',
};

// Canonical, direction-aware dedup key. parent_child and "other" are
// directional (order matters); spouse/sibling are symmetric (sorted so
// A-B and B-A land on the same edge).
function relationshipKey(rel) {
    if (rel.type === 'parent_child') return `parent_child:${rel.parent}>${rel.child}`;
    if (rel.type === 'other') return `other:${rel.a}>${rel.b}`;
    const pair = [rel.a, rel.b].sort();
    return `${rel.type}:${pair[0]}|${pair[1]}`;
}

function relationshipParticipants(rel) {
    if (rel.type === 'parent_child') return [rel.parent, rel.child];
    return [rel.a, rel.b];
}

// The actual text a model (or a person) reads. Both directions are stated
// explicitly for asymmetric types rather than left for the reader to infer —
// redundant, but redundancy is exactly what disambiguates a small model.
function relationshipSentence(rel) {
    switch (rel.type) {
        case 'parent_child':
            return `${rel.parent} is ${rel.child}'s parent. ${rel.child} is ${rel.parent}'s child.`;
        case 'spouse':
            return `${rel.a} is married to ${rel.b}.`;
        case 'sibling':
            return `${rel.a} and ${rel.b} are siblings.`;
        case 'other':
        default:
            return `${rel.a} is ${rel.label || 'connected to'} ${rel.b}.`;
    }
}

// Fields stored/displayed as "<number><unit>" — the number is validated and
// the unit is always appended by the extension itself, never typed by hand.
const UNIT_FIELDS = { height: 'cm', weight: 'kg' };

// Extracts the leading non-negative number from a value, or null if none.
function extractNumber(rawValue) {
    const str = String(rawValue ?? '').trim();
    if (!str) return null;
    const match = str.match(/\d+(\.\d+)?/);
    return match ? match[0] : null;
}

// Full normalized form for storage/injection, e.g. "175" + "cm" -> "175cm".
function normalizeMeasurement(rawValue, unit) {
    const num = extractNumber(rawValue);
    return num ? `${num}${unit}` : null;
}

const defaultSettings = {
    enabled: true,
    autoExtract: true,
    extractEveryN: 30,       // messages since last extraction before auto-firing
    extractionWindow: 40,    // how many recent messages get sent to the extractor
    injectionDepth: 1,       // depth 0-2 stays closest to the strongest-attention zone (see README)
    criticalFactsDepth: 0,   // deliberately even closer than injectionDepth — see README "Critical constraints"
    injectionRole: extension_prompt_roles.SYSTEM,
    floatingPanelOpen: false,
    floatingPanelPos: null,  // { top, left } in px, persisted across sessions
    koboldBaseUrl: '',       // e.g. http://127.0.0.1:5001 — leave blank to skip grammar mode
    koboldMaxContext: 8192,
    koboldMaxLength: 512,
    fallbackResponseLength: 1024, // independent of ST's main "Response (tokens)" setting
};

// A GBNF grammar that structurally forces the output to be exactly
// {"updates": {"<name>": {<any valid JSON object>}, ...}}. The outer shape
// is locked; per-character field objects stay generically JSON-valid (any
// keys/values) so we don't have to hand-encode every field name into the
// grammar and risk it going stale as fields change.
const JSON_SHAPE_GRAMMAR = `
root    ::= "{" ws "\\"updates\\"" ws ":" ws updates (ws "," ws "\\"relationships\\"" ws ":" ws relationships)? ws "}" ws
updates ::= "{" ws (pair ("," ws pair)*)? "}" ws
pair    ::= string ":" ws fields
fields  ::= "{" ws (fpair ("," ws fpair)*)? "}" ws
fpair   ::= string ":" ws value

relationships ::=
  "[" ws (
            fields
    ("," ws fields)*
  )? "]" ws

value  ::= object | array | string | number | ("true" | "false" | "null") ws

object ::=
  "{" ws (
            string ":" ws value
    ("," ws string ":" ws value)*
  )? "}" ws

array  ::=
  "[" ws (
            value
    ("," ws value)*
  )? "]" ws

string ::=
  "\\"" (
    [^"\\\\\\x7F\\x00-\\x1F] |
    "\\\\" (["\\\\bfnrt] | "u" [0-9a-fA-F]{4})
  )* "\\"" ws

number ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9] [1-9]{0,15})? ws

ws ::= | " " | "\\n" [ \\t]{0,20}
`.trim();

// ---------------------------------------------------------------------------
// Settings (global, per-install)
// ---------------------------------------------------------------------------

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

// ---------------------------------------------------------------------------
// Registry (per-chat, lives in chat_metadata -> saved to disk with the chat)
// ---------------------------------------------------------------------------

function emptyRegistry() {
    return {
        entities: {},          // name -> { fields: {}, locks: {}, included: true }
        lastExtractedIndex: 0, // index into context.chat up to which we've extracted
        pendingConflicts: [],  // proposed changes to locked fields awaiting confirmation
        worldNotes: { text: '', locked: false }, // freeform, manual-only, never touched by extraction
        relationships: [],               // shared graph of inter-character relationship edges
        pendingRelationshipConflicts: [], // proposed changes to locked edges awaiting confirmation
    };
}

function getRegistry() {
    const context = getContext();
    const metadata = context.chatMetadata || {};
    const existing = metadata[MODULE_NAME];
    if (!existing) {
        return emptyRegistry();
    }
    return {
        entities: existing.entities ?? {},
        lastExtractedIndex: existing.lastExtractedIndex ?? 0,
        pendingConflicts: existing.pendingConflicts ?? [],
        worldNotes: existing.worldNotes ?? { text: '', locked: false },
        relationships: existing.relationships ?? [],
        pendingRelationshipConflicts: existing.pendingRelationshipConflicts ?? [],
    };
}

function saveRegistry(registry) {
    const context = getContext();
    // updateChatMetadata reassigns the module-level chat_metadata object, so
    // always write through it rather than mutating a captured reference.
    context.updateChatMetadata({ [MODULE_NAME]: registry }, false);
    context.saveMetadataDebounced();
}

function ensureEntity(registry, name) {
    if (!registry.entities[name]) {
        registry.entities[name] = {
            fields: {},
            locks: {},
            included: true,
            criticalFacts: [], // manual-only hard constraints — never touched by extraction, see README
        };
    }
    if (!registry.entities[name].criticalFacts) {
        registry.entities[name].criticalFacts = [];
    }
    return registry.entities[name];
}

function valuesEqual(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        const arrA = (Array.isArray(a) ? a : [a]).map(String).sort();
        const arrB = (Array.isArray(b) ? b : [b]).map(String).sort();
        return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
    }
    return a === b;
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(chatSlice, registry) {
    const transcript = chatSlice
        .filter(m => !m.is_system)
        .map(m => `${m.name || (m.is_user ? 'User' : 'Assistant')}: ${m.mes}`)
        .join('\n');

    const currentRegistry = {};
    for (const [name, entity] of Object.entries(registry.entities)) {
        currentRegistry[name] = entity.fields;
    }

    const currentRelationships = registry.relationships.map(rel => ({
        type: rel.type,
        ...(rel.type === 'parent_child' ? { parent: rel.parent, child: rel.child } : { a: rel.a, b: rel.b }),
        ...(rel.type === 'other' ? { label: rel.label } : {}),
    }));

    return [
        'You maintain a structured fact registry about the characters in a roleplay chat.',
        'Below is the current registry (may be empty) and a recent slice of the chat transcript.',
        '',
        'Return ONLY a JSON object, no prose, no code fences, in this exact shape:',
        '{',
        '  "updates": {',
        '    "<character name>": {',
        `      "name": "...", "sex": "...", "age": "...", "pronouns": "...", "species": "...", "height": "...", "physique": "...",`,
        `      "relationship_to_user": "...", "weight": "...", "status": "...", "key_facts": ["..."]`,
        '    }',
        '  },',
        '  "relationships": [',
        '    { "type": "parent_child", "parent": "<name>", "child": "<name>" },',
        '    { "type": "spouse", "a": "<name>", "b": "<name>" },',
        '    { "type": "sibling", "a": "<name>", "b": "<name>" },',
        '    { "type": "other", "a": "<name>", "b": "<name>", "label": "<short verb phrase, e.g. \\"mentor of\\", \\"rival of\\", \\"employer of\\">" }',
        '  ]',
        '}',
        '',
        'Rules for "updates":',
        '- For each character in this transcript slice, give your best current value for every field you have information for, whether or not the registry already has one. Re-stating an unchanged field is expected, not wasteful.',
        '- Omit a field entirely if the transcript gives no information about it — never guess.',
        '- "physique" is general build (e.g. "athletic", "stocky", "slender"), any character.',
        '- "sex" must be exactly "male" or "female" if determinable, omitted otherwise.',
        '- "height" and "weight" are plain numbers only, in centimeters and kilograms (e.g. "180", not "180cm" or "5\'11\""). Convert imperial units. Omit if not a determinable number.',
        '- Only include characters who actually appear in this transcript slice.',
        '- "relationship_to_user" is ONLY that character\'s relationship to {{user}}. A relationship between two OTHER characters never goes here and never goes in key_facts — it always goes in the separate "relationships" array below.',
        '',
        'Rules for "relationships" — relationships BETWEEN tracked characters, never involving {{user}}:',
        '- "type" is exactly one of: "parent_child", "spouse", "sibling", "other".',
        '- "parent_child" uses "parent"/"child" (not "a"/"b") — the direction matters most here.',
        '- "spouse" and "sibling" use "a"/"b"; order doesn\'t matter.',
        '- "other" covers anything else (mentor, rival, employer, friend, enemy...) — "a", "b", plus a short "label" verb-phrase so "A is <label> B" reads naturally.',
        '- Only include a relationship the transcript actually states or clearly implies — never invent a family/social structure.',
        '- Re-state a relationship from "Current relationships" below if it\'s still true, so it isn\'t forgotten. Only contradict an existing one if the transcript explicitly changed it.',
        '- Every name here must already be a tracked character in "Current registry" below, or one you\'re introducing in this same "updates" object — never invent a participant.',
        '',
        '### Current registry',
        JSON.stringify(currentRegistry, null, 2),
        '',
        '### Current relationships',
        JSON.stringify(currentRelationships, null, 2),
        '',
        '### Recent transcript',
        transcript,
    ].join('\n');
}

// Finds the first balanced {...} object in text, correctly skipping braces
// that appear inside string literals. Returns null if none found or the
// object is truncated/unbalanced (e.g. response got cut off at max_length) —
// callers treat that as NO_JSON rather than trying to parse garbage.
function extractFirstJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        if (ch === '\\') {
            escapeNext = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null; // unbalanced
}

function parseExtractionResult(rawText) {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const candidate = extractFirstJsonObject(cleaned);
    if (!candidate) {
        const err = new Error('No balanced JSON object found in extraction response');
        err.code = 'NO_JSON';
        throw err;
    }
    // Let JSON.parse's SyntaxError propagate as-is — the caller distinguishes
    // "no JSON at all" (err.code === 'NO_JSON') from "JSON-shaped but broken".
    return JSON.parse(candidate);
}

function mergeExtractionResult(registry, result) {
    const updates = result.updates || {};
    let touched = 0;

    for (const [rawName, data] of Object.entries(updates)) {
        const name = String(rawName).trim();
        if (!name) continue;
        const entity = ensureEntity(registry, name);
        let entityTouched = false;

        for (const field of ALL_FIELDS) {
            if (data[field] === undefined || data[field] === null || data[field] === '') continue;

            let proposed = ARRAY_FIELDS.includes(field) && !Array.isArray(data[field])
                ? [data[field]]
                : data[field];

            // "sex" is a fixed male/female choice (drives body-detail visibility) —
            // normalize casing and reject anything that isn't exactly one of the two.
            if (field === 'sex') {
                const normalized = String(proposed).trim().toLowerCase();
                if (normalized !== 'male' && normalized !== 'female') continue;
                proposed = normalized;
            }

            // height/weight/bust/waist/hip must be "<number><unit>" — reject
            // anything with no extractable number rather than storing free text.
            if (UNIT_FIELDS[field]) {
                const normalized = normalizeMeasurement(proposed, UNIT_FIELDS[field]);
                if (!normalized) continue;
                proposed = normalized;
            }

            const current = entity.fields[field];
            const locked = !!entity.locks[field];

            if (!locked) {
                if (!valuesEqual(current, proposed)) {
                    entity.fields[field] = proposed;
                    entityTouched = true;
                }
                continue;
            }

            // Locked: fill freely if still empty (nothing to protect yet).
            if (current === undefined) {
                entity.fields[field] = proposed;
                entityTouched = true;
                continue;
            }

            // Locked and already set: only surface it if it actually disagrees.
            if (!valuesEqual(current, proposed)) {
                registry.pendingConflicts.push({
                    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    entity: name,
                    field,
                    oldValue: current,
                    newValue: proposed,
                });
            }
        }

        if (entityTouched) touched++;
    }

    return { registry, touched };
}

// Validates a single proposed relationship has the fields its type needs and
// every participant it names is (or will be) a known entity — silently
// dropping anything malformed rather than storing a half-formed edge.
// Case/whitespace-forgiving lookup — a manually-typed name only needs to
// match a tracked entity approximately; returns the entity's *canonical*
// key (correct original casing) so stored relationships stay consistent
// with how that character is actually keyed, or null if there's no match.
function resolveEntityName(registry, rawName) {
    const trimmed = String(rawName || '').trim();
    if (!trimmed) return null;
    if (registry.entities[trimmed]) return trimmed;
    const lower = trimmed.toLowerCase();
    return Object.keys(registry.entities).find(n => n.toLowerCase() === lower) || null;
}

function isValidRelationshipShape(rel, registry) {
    if (!rel || typeof rel !== 'object' || !RELATIONSHIP_TYPES.includes(rel.type)) return false;
    const roleKeys = rel.type === 'parent_child' ? ['parent', 'child'] : ['a', 'b'];
    const resolved = {};
    for (const key of roleKeys) {
        const canonical = resolveEntityName(registry, rel[key]);
        if (!canonical) return false; // not a tracked entity — don't store a dangling reference
        resolved[key] = canonical;
    }
    if (resolved[roleKeys[0]] === resolved[roleKeys[1]]) return false; // no self-relationships
    Object.assign(rel, resolved); // normalize to canonical casing in place
    return true;
}

// For parent_child and spouse specifically: does a DIFFERENT, locked edge
// already claim this same "slot" (this child's parent; this person's
// spouse)? A same-key update is handled separately above — this catches the
// other half of the bug: a NEW, differently-keyed edge that silently
// contradicts an already-confirmed one, rather than an edit to it. Sibling
// and "other" are deliberately not restricted this way since having several
// is normal for those, not a sign of a mixed-up fact.
function findConflictingLockedEdge(registry, rel) {
    if (rel.type === 'parent_child') {
        return registry.relationships.find(r =>
            r.type === 'parent_child' && r.locked && r.child === rel.child && r.parent !== rel.parent);
    }
    if (rel.type === 'spouse') {
        const key = relationshipKey(rel);
        return registry.relationships.find(r => {
            if (r.type !== 'spouse' || !r.locked || relationshipKey(r) === key) return false;
            return [r.a, r.b].includes(rel.a) || [r.a, r.b].includes(rel.b);
        });
    }
    return null;
}

function mergeRelationships(registry, proposedRelationships) {
    let touched = 0;
    for (const raw of proposedRelationships || []) {
        if (!isValidRelationshipShape(raw, registry)) continue;

        const rel = { ...raw };
        const key = relationshipKey(rel);
        const existingIndex = registry.relationships.findIndex(r => relationshipKey(r) === key);
        const existing = existingIndex === -1 ? null : registry.relationships[existingIndex];

        if (existing) {
            if (!existing.locked) {
                // Same key, so type/participants already match — only the
                // label (for "other") can meaningfully differ between passes.
                if (existing.label !== rel.label) {
                    existing.label = rel.label;
                    touched++;
                }
                continue;
            }
            // Locked: only surface it if the proposal actually disagrees.
            if (existing.label !== rel.label) {
                registry.pendingRelationshipConflicts.push({
                    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    relationshipId: existing.id,
                    newLabel: rel.label,
                    oldSentence: relationshipSentence(existing),
                    newSentence: relationshipSentence(rel),
                });
            }
            continue;
        }

        // New key. Before adding it as a fresh fact, make sure it doesn't
        // silently contradict an already-locked, differently-keyed edge —
        // e.g. this child already has a different confirmed, locked parent.
        const conflictingEdge = findConflictingLockedEdge(registry, rel);
        if (conflictingEdge) {
            registry.pendingRelationshipConflicts.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                relationshipId: conflictingEdge.id,
                isNewContradictingEdge: true,
                proposedEdge: rel,
                oldSentence: relationshipSentence(conflictingEdge),
                newSentence: relationshipSentence(rel),
            });
            continue;
        }

        registry.relationships.push({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ...rel,
            locked: false,
        });
        touched++;
    }
    return { registry, touched };
}

// Error codes, in the order a run can hit them. Each has a fixed, specific
// user-facing message plus a concrete next step — never just "failed".
const ERROR_CODES = {
    NO_CHAT: {
        message: 'No chat messages yet',
        hint: 'Send or receive at least one message first, then Rescan.',
    },
    GENERATION_FAILED: {
        message: 'The backend call for the quiet extraction prompt failed',
        hint: 'Check that KoboldCPP is running and connected in the API panel — this is the same connection your normal replies use.',
    },
    EMPTY_RESPONSE: {
        message: 'The model returned an empty response',
        hint: 'Try Rescan again. If it keeps happening, check the quiet-generation max response length in your connection settings.',
    },
    NO_JSON: {
        message: 'The model did not return any JSON at all',
        hint: 'It ignored the extraction instructions — try a more capable/instruction-following model, or lower "Messages sent per extraction pass" so the prompt is shorter.',
    },
    BAD_JSON: {
        message: 'The model returned JSON-like text that failed to parse',
        hint: 'Common with small/quantized local models under load. Try Rescan again; if it persists, try a different model for extraction.',
    },
    BAD_SHAPE: {
        message: 'Parsed JSON but it was missing the expected "updates" object',
        hint: 'The model didn\u2019t follow the requested format. Try Rescan again.',
    },
    MERGE_FAILED: {
        message: 'Internal error while applying the extracted data to the registry',
        hint: 'This looks like a bug in the extension rather than the model\u2019s output — check the browser console for the stack trace.',
    },
    SAVE_FAILED: {
        message: 'Failed to save the registry into chat metadata',
        hint: 'Check the browser console — could be a storage/permissions issue with the chat file, or the chat changed mid-save.',
    },
    GRAMMAR_UNREACHABLE: {
        message: 'Could not reach the KoboldCPP URL configured for grammar-constrained extraction',
        hint: 'Check the "KoboldCPP API URL" setting is correct and the server is running. If your browser console shows a CORS error, KoboldCPP needs to be reachable from this page\u2019s origin.',
    },
    GRAMMAR_HTTP_ERROR: {
        message: 'KoboldCPP returned an error response for the grammar-constrained call',
        hint: 'Check the KoboldCPP console/log for details — the URL responded but rejected the request.',
    },
    GRAMMAR_TIMEOUT: {
        message: 'The grammar-constrained call timed out with no response',
        hint: 'KoboldCPP may be busy serving the main chat generation, or stuck. Check its console, and avoid Rescanning while a reply is still generating.',
    },
};

const GRAMMAR_CALL_TIMEOUT_MS = 120000;

async function callGrammarConstrained(prompt, settings) {
    const baseUrl = settings.koboldBaseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/api/v1/generate`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GRAMMAR_CALL_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                grammar: JSON_SHAPE_GRAMMAR,
                max_length: settings.koboldMaxLength,
                max_context_length: settings.koboldMaxContext,
                temperature: 0.2,
                rep_pen: 1.0,
            }),
            signal: controller.signal,
        });
    } catch (err) {
        const wrapped = new Error(err.message);
        wrapped.code = err.name === 'AbortError' ? 'GRAMMAR_TIMEOUT' : 'GRAMMAR_UNREACHABLE';
        throw wrapped;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.code = 'GRAMMAR_HTTP_ERROR';
        throw err;
    }

    const data = await response.json();
    return data?.results?.[0]?.text ?? '';
}

async function getRawExtraction(prompt, settings) {
    if (settings.koboldBaseUrl) {
        return await callGrammarConstrained(prompt, settings);
    }
    const context = getContext();
    // Independent of ST's main "Response (tokens)" setting — generateQuietPrompt
    // temporarily swaps it for this call only, then restores it. Without this,
    // extraction silently inherits whatever your main chat response length is
    // set to, which is usually far too short for a full JSON registry dump and
    // causes truncated/unparseable output (NO_JSON, BAD_JSON).
    return await context.generateQuietPrompt({ quietPrompt: prompt, responseLength: settings.fallbackResponseLength });
}

function buildRepairPrompt(brokenText) {
    return [
        'The following text was supposed to be a single JSON object matching this exact shape:',
        '{ "updates": { "<character name>": { "<field>": "<value>", ... }, ... } }',
        'It is not valid JSON, or is missing the "updates" key. Return ONLY the corrected JSON object — no prose, no code fences.',
        '',
        '### Broken output',
        brokenText,
    ].join('\n');
}

function reportError(code, err, rawResult) {
    const def = ERROR_CODES[code] || { message: 'Unknown error', hint: 'Check the browser console.' };
    console.error(`[Character Registry Tracker] [${code}] ${def.message}`, err || '', rawResult !== undefined ? { rawResult } : '');
    setStatus(`✗ [${code}] ${def.message}. ${def.hint}`, 'error');
}

let isExtracting = false;
let mainGenerationActive = false;

function setExtractionInProgress(active) {
    $('.crt_rescan_btn').prop('disabled', active);
}

async function runExtraction(manual = false) {
    if (isExtracting) {
        if (manual) setStatus('An extraction is already in progress — wait for it to finish.', 'info');
        return;
    }
    // Deliberately not blocking on "main generation in progress" here anymore.
    // That guard depended on ST's GENERATION_STARTED/ENDED pairing exactly
    // matching our assumptions, and broke in more than one way in practice
    // (non-streaming setups, our own quiet calls tripping it on themselves).
    // KoboldCPP queues a concurrent request rather than corrupting anything,
    // so the actual cost of getting this wrong was just "extraction waits a
    // bit longer" — not worth the recurring false-block bugs. If the main
    // chat happens to be generating, just let the user know and proceed.
    if (manual && mainGenerationActive) {
        setStatus('Main chat looks like it\u2019s still generating — extraction may take a bit longer than usual.', 'info');
    }

    isExtracting = true;
    setExtractionInProgress(true);
    try {
        await runExtractionInner(manual);
    } finally {
        isExtracting = false;
        setExtractionInProgress(false);
    }
}

async function runExtractionInner(manual) {
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat || [];
    const registry = getRegistry();

    if (!manual && !settings.autoExtract) return;
    if (chat.length === 0) {
        if (manual) reportError('NO_CHAT');
        return;
    }

    const startIndex = Math.max(0, chat.length - settings.extractionWindow);
    const chatSlice = chat.slice(startIndex);
    if (chatSlice.length === 0) {
        if (manual) reportError('NO_CHAT');
        return;
    }

    const prompt = buildExtractionPrompt(chatSlice, registry);
    setStatus(settings.koboldBaseUrl ? 'Extracting (grammar-constrained)…' : 'Extracting character facts…', 'info');

    let rawResult;
    try {
        rawResult = await getRawExtraction(prompt, settings);
    } catch (err) {
        const code = ['GRAMMAR_UNREACHABLE', 'GRAMMAR_HTTP_ERROR', 'GRAMMAR_TIMEOUT'].includes(err.code)
            ? err.code
            : 'GENERATION_FAILED';
        reportError(code, err);
        return;
    }

    if (!rawResult || !String(rawResult).trim()) {
        reportError('EMPTY_RESPONSE');
        return;
    }

    let parsed = tryParseAndValidate(rawResult);

    // One automatic repair pass before surfacing an error to the user.
    // Grammar mode should essentially never need this; the non-grammar
    // fallback path is where this earns its keep.
    if (!parsed.ok) {
        setStatus('First response wasn\u2019t usable — retrying with a repair pass…', 'info');
        try {
            const repaired = await getRawExtraction(buildRepairPrompt(rawResult), settings);
            parsed = tryParseAndValidate(repaired);
            if (!parsed.ok) parsed.rawResult = repaired;
        } catch (err) {
            // Repair call itself failed — report the ORIGINAL parse error,
            // since that's the more informative root cause.
        }
    }

    if (!parsed.ok) {
        reportError(parsed.code, parsed.err, parsed.rawResult ?? rawResult);
        return;
    }

    let touched;
    try {
        ({ touched } = mergeExtractionResult(registry, parsed.value));
    } catch (err) {
        reportError('MERGE_FAILED', err);
        return;
    }

    let relationshipsTouched = 0;
    try {
        ({ touched: relationshipsTouched } = mergeRelationships(registry, parsed.value.relationships));
    } catch (err) {
        reportError('MERGE_FAILED', err);
        return;
    }

    try {
        registry.lastExtractedIndex = chat.length;
        saveRegistry(registry);
    } catch (err) {
        reportError('SAVE_FAILED', err);
        return;
    }

    updateInjection();
    renderEntityList();
    setStatus(`✓ Registry updated (${touched} character(s), ${relationshipsTouched} relationship(s) touched).`, 'ok');
}

function tryParseAndValidate(rawResult) {
    let parsed;
    try {
        parsed = parseExtractionResult(rawResult);
    } catch (err) {
        return { ok: false, code: err.code === 'NO_JSON' ? 'NO_JSON' : 'BAD_JSON', err };
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.updates !== 'object' || parsed.updates === null) {
        return { ok: false, code: 'BAD_SHAPE' };
    }
    return { ok: true, value: parsed };
}

async function checkAutoExtract() {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoExtract) return;

    const context = getContext();
    const chat = context.chat || [];
    const registry = getRegistry();

    // Clamp against a shrunk chat (deleted messages) so a stale watermark
    // higher than the current length can't permanently stall auto-extract.
    const lastIndex = Math.min(registry.lastExtractedIndex, chat.length);

    if (chat.length - lastIndex >= settings.extractEveryN) {
        await runExtraction(false);
    }
}

// ---------------------------------------------------------------------------
// Injection (Author's-Note-style: fixed depth, IN_CHAT position)
// ---------------------------------------------------------------------------

function formatEntityLine(name, entity) {
    const f = entity.fields;
    const parts = [];

    const identityBits = [
        f.age ? `${f.age} y/o` : null,
        f.pronouns,
        f.species,
        f.height,
    ].filter(Boolean);
    if (identityBits.length) parts.push(identityBits.join(', '));

    if (f.physique) parts.push(`Build: ${f.physique}`);

    if (f.relationship_to_user) parts.push(`Relationship to {{user}}: ${f.relationship_to_user}`);
    if (f.status) parts.push(`Status: ${f.status}`);
    if (f.weight) parts.push(`Weight: ${f.weight}`);
    if (Array.isArray(f.key_facts) && f.key_facts.length) {
        parts.push(`Facts: ${f.key_facts.join('; ')}`);
    }

    return `${name}: ${parts.join('. ')}`;
}

function hasAnyField(entity) {
    return ALL_FIELDS.some(f => {
        const v = entity.fields[f];
        return Array.isArray(v) ? v.length > 0 : !!v;
    });
}

function buildRelationshipsInjectionText(registry) {
    const lines = registry.relationships
        .filter(rel => {
            const [p1, p2] = relationshipParticipants(rel);
            const e1 = registry.entities[p1];
            const e2 = registry.entities[p2];
            return e1 && e1.included && e2 && e2.included;
        })
        .map(relationshipSentence);

    if (lines.length === 0) return '';
    return ['[Relationships]', ...lines, '[/Relationships]'].join('\n');
}

function buildInjectionText(registry) {
    const lines = Object.entries(registry.entities)
        .filter(([, entity]) => entity.included && hasAnyField(entity))
        .map(([name, entity]) => formatEntityLine(name, entity));

    const parts = [];
    if (lines.length > 0) {
        parts.push(['[Character Registry]', ...lines, '[/Character Registry]'].join('\n'));
    }

    const relationshipsText = buildRelationshipsInjectionText(registry);
    if (relationshipsText) parts.push(relationshipsText);

    return parts.join('\n');
}

function buildWorldNotesInjectionText(registry) {
    const text = (registry.worldNotes && registry.worldNotes.text || '').trim();
    if (!text) return '';
    return `[World Info]\n${text}\n[/World Info]`;
}

function buildCriticalFactsInjectionText(registry) {
    const lines = [];
    for (const [name, entity] of Object.entries(registry.entities)) {
        if (!entity.included) continue;
        for (const fact of entity.criticalFacts || []) {
            if (!fact) continue;
            lines.push(`MUST NOT be contradicted — ${name}: ${fact}.`);
        }
    }
    if (lines.length === 0) return '';
    return ['[Critical Constraints]', ...lines, '[/Critical Constraints]'].join('\n');
}

function updateInjection() {
    const settings = getSettings();
    const context = getContext();
    const registry = getRegistry();

    const registryText = settings.enabled ? buildInjectionText(registry) : '';
    context.setExtensionPrompt(EXT_PROMPT_KEY, registryText, extension_prompt_types.IN_CHAT, settings.injectionDepth, false, settings.injectionRole);

    // World notes are independent of the "enabled" toggle above (that toggle
    // is specifically about the auto-extracted character registry) and use
    // IN_PROMPT rather than a chat depth — that anchors it next to the
    // scenario/description in the assembled prompt instead of scrolling
    // through chat history, which is the "most important level" placement
    // this kind of always-true world/setting fact calls for.
    const worldNotesText = buildWorldNotesInjectionText(registry);
    context.setExtensionPrompt(WORLD_NOTES_PROMPT_KEY, worldNotesText, extension_prompt_types.IN_PROMPT, 0, false, settings.injectionRole);

    // Critical constraints get their OWN, even closer depth than the
    // character registry, and are independent of "enabled" too (manual-only
    // data, like world notes — see README "Critical constraints").
    const criticalFactsText = buildCriticalFactsInjectionText(registry);
    context.setExtensionPrompt(CRITICAL_FACTS_PROMPT_KEY, criticalFactsText, extension_prompt_types.IN_CHAT, settings.criticalFactsDepth, false, settings.injectionRole);
}

// ---------------------------------------------------------------------------
// Export — standalone Height Comparison tool (separate static HTML page,
// not embedded in ST). Plain JSON in the shape the chart page's own Import
// JSON button already expects. Only name + height + the manually-chosen
// stencil ever leave this registry; "custom" stencils (uploaded images)
// aren't offered since we have none.
// ---------------------------------------------------------------------------

function exportableEntities(registry) {
    return Object.entries(registry.entities)
        .filter(([, entity]) => extractNumber(entity.fields.height) !== null)
        .sort(([a], [b]) => a.localeCompare(b));
}

// Sex-based stencil for export, overriding the manual per-character pick
// when sex is known (falls back to the manual dropdown otherwise).
const FEMALE_STENCIL_OPTIONS = ['figure-pose', 'figure-back', 'figure'];

function pickStencilForExport(entity) {
    const sex = entity.fields.sex;
    if (sex === 'male') return 'figure-male';
    if (sex === 'female') return FEMALE_STENCIL_OPTIONS[Math.floor(Math.random() * FEMALE_STENCIL_OPTIONS.length)];
    return DEFAULT_STENCIL;
}

function buildHeightChartExport(registry) {
    const entries = exportableEntities(registry).map(([name, entity], i) => ({
        id: `crt_${i}_${Date.now()}`,
        name,
        heightCm: Number(extractNumber(entity.fields.height)),
        color: EXPORT_COLOR_PALETTE[i % EXPORT_COLOR_PALETTE.length],
        stencil: pickStencilForExport(entity),
        customImage: null,
    }));
    return { settings: { unit: 'metric', pxPerCm: 2.0 }, entries };
}

function exportHeightChart() {
    const registry = getRegistry();
    const data = buildHeightChartExport(registry);

    if (data.entries.length === 0) {
        setStatus('No tracked characters have a height set yet — nothing to export.', 'error');
        return;
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'height-comparison.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`✓ Exported ${data.entries.length} character(s) to height-comparison.json — open the Height Comparison page and use its "Import JSON" button.`, 'ok');
}

// ---------------------------------------------------------------------------
// UI — shared markup builders (rendered into both the settings-drawer panel
// and the floating window; they stay in sync because both re-render on
// every registry change)
// ---------------------------------------------------------------------------

function setStatus(text, level = 'info') {
    const $targets = $('.crt_status_target');
    $targets.text(text);
    $targets.removeClass('crt_status_ok crt_status_error crt_status_info');
    $targets.addClass(`crt_status_${level}`);
}

function fieldRowHtml(entityName, field, value, locked) {
    const safeEntity = escapeHtml(entityName);
    const inputId = `crt_field_${safeEntity}_${field}`;
    const lockCheckbox = `
            <label class="checkbox_label crt_lock_label" title="Lock: protects this field from silent overwrite. A later proposed change is queued as a conflict instead of applied.">
                <input type="checkbox" class="crt_lock_toggle"
                    data-entity="${safeEntity}" data-field="${escapeHtml(field)}"
                    ${locked ? 'checked' : ''} />
                lock
            </label>`;

    if (field === 'sex') {
        const optionsHtml = SEX_OPTIONS.map(opt => {
            const label = opt === '' ? '(unset)' : opt.charAt(0).toUpperCase() + opt.slice(1);
            const selected = (value || '') === opt ? ' selected' : '';
            return `<option value="${opt}"${selected}>${label}</option>`;
        }).join('');
        return `
        <div class="crt_field_row">
            <label for="${inputId}">${escapeHtml(field)}</label>
            <select id="${inputId}" class="text_pole crt_field_input"
                data-entity="${safeEntity}" data-field="${escapeHtml(field)}">${optionsHtml}</select>${lockCheckbox}
        </div>`;
    }

    if (UNIT_FIELDS[field]) {
        const unit = UNIT_FIELDS[field];
        const numericOnly = extractNumber(value) ?? '';
        return `
        <div class="crt_field_row">
            <label for="${inputId}">${escapeHtml(field)}</label>
            <div class="crt_unit_input_wrap">
                <input type="text" inputmode="decimal" id="${inputId}" class="text_pole crt_field_input crt_unit_input"
                    data-entity="${safeEntity}" data-field="${escapeHtml(field)}"
                    value="${escapeHtml(numericOnly)}" placeholder="e.g. 175" />
                <span class="crt_unit_suffix">${unit}</span>
            </div>${lockCheckbox}
        </div>`;
    }

    const displayValue = Array.isArray(value) ? value.join('; ') : (value ?? '');
    return `
        <div class="crt_field_row">
            <label for="${inputId}">${escapeHtml(field)}</label>
            <input type="text" id="${inputId}" class="text_pole crt_field_input"
                data-entity="${safeEntity}" data-field="${escapeHtml(field)}"
                value="${escapeHtml(displayValue)}" />${lockCheckbox}
        </div>`;
}

function conflictRowHtml(conflict) {
    const oldDisplay = Array.isArray(conflict.oldValue) ? conflict.oldValue.join('; ') : conflict.oldValue;
    const newDisplay = Array.isArray(conflict.newValue) ? conflict.newValue.join('; ') : conflict.newValue;
    return `
        <div class="crt_conflict_row" data-id="${escapeHtml(conflict.id)}">
            <strong>${escapeHtml(conflict.entity)}.${escapeHtml(conflict.field)}</strong> is locked at
            "${escapeHtml(oldDisplay)}" — extraction proposed "${escapeHtml(newDisplay)}".
            <button class="menu_button crt_conflict_accept" data-id="${escapeHtml(conflict.id)}">Accept new value</button>
            <button class="menu_button crt_conflict_reject" data-id="${escapeHtml(conflict.id)}">Keep locked value</button>
        </div>`;
}

function relationshipRowHtml(rel) {
    const safeId = escapeHtml(rel.id);
    const labelInput = rel.type === 'other'
        ? `<input type="text" class="text_pole crt_relationship_label_input" data-id="${safeId}" value="${escapeHtml(rel.label || '')}" placeholder="e.g. mentor of" />`
        : '';
    return `
        <div class="crt_relationship_row" data-id="${safeId}">
            <div class="crt_relationship_sentence">${escapeHtml(relationshipSentence(rel))}</div>
            ${labelInput}
            <label class="checkbox_label crt_lock_label" title="Lock: protects this fact. A later proposal that contradicts it (a new edge, or a changed label) is queued below for you to accept/reject instead of applied silently.">
                <input type="checkbox" class="crt_relationship_lock" data-id="${safeId}" ${rel.locked ? 'checked' : ''} />
                lock
            </label>
            <button class="menu_button crt_relationship_delete" data-id="${safeId}">Delete</button>
        </div>`;
}

function buildRelationshipListHtml(registry) {
    if (registry.relationships.length === 0) {
        return '<div class="crt_empty">No relationships tracked yet.</div>';
    }
    return registry.relationships.map(relationshipRowHtml).join('');
}

// Populates the two name dropdowns in an "Add relationship" row from
// currently tracked characters — a dropdown can't typo or mis-case a name
// the way free text could, so this replaces what used to be manual entry
// plus a forgiving lookup. Placeholder option text swaps to Parent/Child
// for that type, First/Second person otherwise. Preserves the current
// selection across a refresh where possible.
function populateRelationshipNameSelects($row, registry) {
    const type = $row.find('.crt_add_relationship_type').val();
    const isParentChild = type === 'parent_child';
    const label1 = isParentChild ? 'Parent' : 'First person';
    const label2 = isParentChild ? 'Child' : 'Second person';
    const names = Object.keys(registry.entities).sort();

    const optionsHtml = (placeholderLabel) => [
        `<option value="" disabled>${escapeHtml(placeholderLabel)}</option>`,
        ...names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`),
    ].join('');

    const $sel1 = $row.find('.crt_add_relationship_name1');
    const $sel2 = $row.find('.crt_add_relationship_name2');
    const prev1 = $sel1.val();
    const prev2 = $sel2.val();

    $sel1.html(optionsHtml(label1));
    $sel2.html(optionsHtml(label2));

    $sel1.val(names.includes(prev1) ? prev1 : '');
    $sel2.val(names.includes(prev2) ? prev2 : '');
}

function relationshipConflictRowHtml(conflict) {
    return `
        <div class="crt_conflict_row" data-id="${escapeHtml(conflict.id)}">
            Locked relationship: "${escapeHtml(conflict.oldSentence)}" — extraction proposed instead:
            "${escapeHtml(conflict.newSentence)}".
            <button class="menu_button crt_relationship_conflict_accept" data-id="${escapeHtml(conflict.id)}">Accept new</button>
            <button class="menu_button crt_relationship_conflict_reject" data-id="${escapeHtml(conflict.id)}">Keep existing</button>
        </div>`;
}

function buildRelationshipConflictListHtml(registry) {
    if (registry.pendingRelationshipConflicts.length === 0) return '';
    const rows = registry.pendingRelationshipConflicts.map(relationshipConflictRowHtml).join('');
    return `<h4 class="crt_conflict_heading">⚠ Pending relationship conflicts (${registry.pendingRelationshipConflicts.length})</h4>${rows}`;
}

function criticalFactsBlockHtml(name, entity) {
    const safeName = escapeHtml(name);
    const facts = entity.criticalFacts || [];
    const rows = facts.map((fact, i) => `
        <div class="crt_critical_fact_row" data-entity="${safeName}" data-index="${i}">
            <span class="crt_critical_fact_text">${escapeHtml(fact)}</span>
            <button class="menu_button crt_critical_fact_delete" data-entity="${safeName}" data-index="${i}">Delete</button>
        </div>`).join('');

    return `
        <div class="crt_field_group crt_critical_facts_group">
            <em>Critical constraints (manual, never touched by extraction)</em>
            <div class="crt_hint">Injected as an explicit "MUST NOT be contradicted" rule, at a closer/stronger position than the rest of this character's data — for hard physical or behavioral limits the model keeps ignoring otherwise (e.g. a giant sleeping in a normal bed). Keep each entry short and concrete.</div>
            ${rows || '<div class="crt_empty">None yet.</div>'}
            <div class="crt_add_critical_fact_row">
                <input type="text" class="text_pole crt_add_critical_fact_input" data-entity="${safeName}" placeholder="e.g. cannot fit inside buildings, doorways, or furniture — he is 50m tall" />
                <button class="menu_button crt_add_critical_fact_btn" data-entity="${safeName}">Add</button>
            </div>
        </div>`;
}

function entitySummaryLine(entity, relCount) {
    const f = entity.fields;
    const bits = [f.sex, f.age ? `${f.age}y` : null, f.height || null].filter(Boolean);
    const counts = [];
    if (relCount > 0) counts.push(`${relCount} relationship${relCount === 1 ? '' : 's'}`);
    const factCount = (entity.criticalFacts || []).length;
    if (factCount > 0) counts.push(`${factCount} constraint${factCount === 1 ? '' : 's'}`);
    const parts = [...bits, ...counts];
    return parts.length ? escapeHtml(parts.join(' · ')) : '<span class="crt_entity_summary_empty">no details yet</span>';
}

function entityBlockHtml(name, entity, relCount) {
    const safeName = escapeHtml(name);
    const isCollapsed = !expandedEntityNames.has(name);
    const identityRows = IDENTITY_FIELDS
        .map(f => fieldRowHtml(name, f, entity.fields[f], !!entity.locks[f]))
        .join('');
    const stateRows = STATE_FIELDS
        .map(f => fieldRowHtml(name, f, entity.fields[f], !!entity.locks[f]))
        .join('');

    const bodyHtml = isCollapsed ? '' : `
            <div class="crt_field_group"><em>Identity</em>${identityRows}</div>
            <div class="crt_field_group"><em>Story state</em>${stateRows}</div>
            ${criticalFactsBlockHtml(name, entity)}`;

    return `
        <div class="crt_entity_block${isCollapsed ? ' crt_collapsed' : ''}" data-entity="${safeName}">
            <div class="crt_entity_header">
                <div class="crt_entity_toggle_zone" title="${isCollapsed ? 'Expand' : 'Collapse'}">
                    <span class="crt_entity_collapse_toggle fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></span>
                    <strong>${safeName}</strong>
                    ${isCollapsed ? `<span class="crt_entity_summary">${entitySummaryLine(entity, relCount)}</span>` : ''}
                </div>
                <label class="checkbox_label">
                    <input type="checkbox" class="crt_include_toggle" data-entity="${safeName}"
                        ${entity.included ? 'checked' : ''} />
                    include in context
                </label>
                <button class="menu_button crt_delete_entity" data-entity="${safeName}">Delete</button>
            </div>${bodyHtml}
        </div>`;
}

function relationshipCountsByEntity(registry) {
    const counts = {};
    for (const rel of registry.relationships) {
        for (const p of relationshipParticipants(rel)) {
            counts[p] = (counts[p] || 0) + 1;
        }
    }
    return counts;
}

function buildEntityListHtml(registry) {
    const names = Object.keys(registry.entities).sort();
    if (names.length === 0) {
        return '<div class="crt_empty">No characters tracked yet. Send some messages or hit Rescan.</div>';
    }
    const relCounts = relationshipCountsByEntity(registry);
    const rows = names.map(name => entityBlockHtml(name, registry.entities[name], relCounts[name] || 0)).join('');
    const bulkControls = names.length > 1
        ? `<div class="crt_bulk_collapse_row">
               <a href="#" class="crt_expand_all_btn">Expand all</a> · <a href="#" class="crt_collapse_all_btn">Collapse all</a>
           </div>`
        : '';
    return bulkControls + rows;
}

function buildConflictListHtml(registry) {
    if (registry.pendingConflicts.length === 0) return '';
    const rows = registry.pendingConflicts.map(conflictRowHtml).join('');
    return `<h4 class="crt_conflict_heading">⚠ Pending conflicts on locked fields (${registry.pendingConflicts.length})</h4>${rows}`;
}

function renderEntityList() {
    const registry = getRegistry();
    const active = document.activeElement;
    const isEditingField = active && (
        active.classList.contains('crt_field_input') || active.classList.contains('crt_add_entity_input') ||
        active.classList.contains('crt_add_critical_fact_input')
    );
    const isEditingRelationship = active && (
        active.classList.contains('crt_relationship_label_input') ||
        active.classList.contains('crt_add_relationship_name1') ||
        active.classList.contains('crt_add_relationship_name2') ||
        active.classList.contains('crt_add_relationship_label')
    );

    // Don't nuke an input the user is actively typing in — a background
    // auto-extraction pass finishing mid-edit shouldn't wipe their keystrokes.
    // The conflict lists are unrelated DOM, so they're always safe to refresh.
    $('.crt_conflict_list_target').html(buildConflictListHtml(registry));
    if (!isEditingField) {
        $('.crt_entity_list_target').html(buildEntityListHtml(registry));
    }

    $('.crt_relationship_conflict_list_target').html(buildRelationshipConflictListHtml(registry));
    if (!isEditingRelationship) {
        $('.crt_relationship_list_target').html(buildRelationshipListHtml(registry));
    }
    $('.crt_add_relationship_row').each(function () {
        populateRelationshipNameSelects($(this), registry);
    });

    const characterCount = Object.keys(registry.entities).length;
    $('.crt_badge_character_count').text(characterCount ? `(${characterCount})` : '');
    $('.crt_badge_conflict_flag').text(registry.pendingConflicts.length ? `⚠ ${registry.pendingConflicts.length}` : '')
        .toggle(registry.pendingConflicts.length > 0);

    $('.crt_badge_relationship_count').text(registry.relationships.length ? `(${registry.relationships.length})` : '');
    $('.crt_badge_relationship_conflict_flag').text(registry.pendingRelationshipConflicts.length ? `⚠ ${registry.pendingRelationshipConflicts.length}` : '')
        .toggle(registry.pendingRelationshipConflicts.length > 0);

    renderWorldNotes(registry);
}

function renderWorldNotes(registry) {
    const notes = (registry || getRegistry()).worldNotes || { text: '', locked: false };
    const active = document.activeElement;
    // Settings-drawer and floating-window textareas are two separate elements
    // syncing the same underlying value — update each independently, skipping
    // only the one currently focused so in-progress typing isn't clobbered.
    $('.crt_world_notes_input').each(function () {
        if (this === active) return;
        if ($(this).val() !== notes.text) $(this).val(notes.text);
        $(this).prop('readonly', !!notes.locked);
    });
    $('.crt_world_notes_lock').prop('checked', !!notes.locked);
}

// ---------------------------------------------------------------------------
// UI — event handling (delegated from document so it covers both mounted
// panel instances without double-binding)
// ---------------------------------------------------------------------------

function bindEntityListEvents() {
    const $doc = $(document);

    $doc.on('change', '.crt_field_input', function () {
        const $el = $(this);
        const registry = getRegistry();
        const entity = ensureEntity(registry, $el.data('entity'));
        const field = $el.data('field');
        const value = $el.val();

        if (UNIT_FIELDS[field]) {
            const normalized = normalizeMeasurement(value, UNIT_FIELDS[field]);
            if (value.trim() && !normalized) {
                setStatus(`"${field}" needs a number (e.g. 175) — not saved.`, 'error');
                $el.val(extractNumber(entity.fields[field]) ?? '');
                return;
            }
            entity.fields[field] = normalized ?? '';
        } else if (ARRAY_FIELDS.includes(field)) {
            entity.fields[field] = value.split(';').map(s => s.trim()).filter(Boolean);
        } else {
            entity.fields[field] = value;
        }

        saveRegistry(registry);
        updateInjection();
        // Safe to catch up the full list now — this fires on blur, so focus
        // has already moved and renderEntityList() won't clobber anything.
        renderEntityList();
    });

    $doc.on('change', '.crt_lock_toggle', function () {
        const $el = $(this);
        const registry = getRegistry();
        const entity = ensureEntity(registry, $el.data('entity'));
        const field = $el.data('field');
        entity.locks[field] = $el.is(':checked');
        saveRegistry(registry);
    });

    $doc.on('change', '.crt_include_toggle', function () {
        const $el = $(this);
        const registry = getRegistry();
        const entity = ensureEntity(registry, $el.data('entity'));
        entity.included = $el.is(':checked');
        saveRegistry(registry);
        updateInjection();
    });

    $doc.on('click', '.crt_delete_entity', function () {
        const name = $(this).data('entity');
        const registry = getRegistry();
        delete registry.entities[name];
        expandedEntityNames.delete(name);
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
    });

    $doc.on('click', '.crt_add_critical_fact_btn', function () {
        const name = $(this).data('entity');
        const $input = $(this).siblings('.crt_add_critical_fact_input');
        const text = $input.val().trim();
        if (!text) return;

        const registry = getRegistry();
        const entity = ensureEntity(registry, name);
        entity.criticalFacts.push(text);
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
    });
    $doc.on('keydown', '.crt_add_critical_fact_input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $(this).trigger('blur'); // blur first — a synthetic click below doesn't blur it on its own
            $(this).siblings('.crt_add_critical_fact_btn').trigger('click');
        }
    });

    $doc.on('click', '.crt_critical_fact_delete', function () {
        const name = $(this).data('entity');
        const index = $(this).data('index');
        const registry = getRegistry();
        const entity = ensureEntity(registry, name);
        entity.criticalFacts.splice(index, 1);
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
    });

    $doc.on('click', '.crt_entity_toggle_zone', function () {
        const name = $(this).closest('.crt_entity_block').data('entity');
        if (expandedEntityNames.has(name)) {
            expandedEntityNames.delete(name);
        } else {
            expandedEntityNames.add(name);
        }
        renderEntityList();
    });

    $doc.on('click', '.crt_expand_all_btn', function (e) {
        e.preventDefault();
        const registry = getRegistry();
        Object.keys(registry.entities).forEach(n => expandedEntityNames.add(n));
        renderEntityList();
    });
    $doc.on('click', '.crt_collapse_all_btn', function (e) {
        e.preventDefault();
        expandedEntityNames.clear();
        renderEntityList();
    });

    $doc.on('click', '.crt_section_header', function () {
        $(this).closest('.crt_section').toggleClass('crt_section_open');
    });

    $doc.on('click', '.crt_conflict_accept', function () {
        resolveConflict($(this).data('id'), true);
    });
    $doc.on('click', '.crt_conflict_reject', function () {
        resolveConflict($(this).data('id'), false);
    });

    $doc.on('click', '.crt_rescan_btn', function () {
        runExtraction(true);
    });

    $doc.on('click', '.crt_export_json_link', function (e) {
        e.preventDefault();
        exportHeightChart();
    });

    $doc.on('click', '.crt_add_entity_btn', function () {
        const $input = $(this).siblings('.crt_add_entity_input');
        addEntityManually($input.val());
        $input.val('');
    });
    $doc.on('keydown', '.crt_add_entity_input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            addEntityManually($(this).val());
            $(this).val('').trigger('blur'); // blur so the guard below doesn't suppress the refresh that shows it
        }
    });

    $doc.on('change', '.crt_world_notes_input', function () {
        const registry = getRegistry();
        if (!registry.worldNotes) registry.worldNotes = { text: '', locked: false };
        if (registry.worldNotes.locked) {
            // Shouldn't normally fire (readonly blocks typing) — guard anyway
            // and re-sync in case it somehow did.
            renderWorldNotes(registry);
            return;
        }
        registry.worldNotes.text = $(this).val();
        saveRegistry(registry);
        updateInjection();
    });

    $doc.on('change', '.crt_world_notes_lock', function () {
        const registry = getRegistry();
        if (!registry.worldNotes) registry.worldNotes = { text: '', locked: false };
        registry.worldNotes.locked = $(this).is(':checked');
        saveRegistry(registry);
        renderWorldNotes(registry);
    });

    $doc.on('change', '.crt_relationship_lock', function () {
        const id = $(this).data('id');
        const registry = getRegistry();
        const rel = registry.relationships.find(r => r.id === id);
        if (rel) rel.locked = $(this).is(':checked');
        saveRegistry(registry);
    });

    $doc.on('click', '.crt_relationship_delete', function () {
        const id = $(this).data('id');
        const registry = getRegistry();
        registry.relationships = registry.relationships.filter(r => r.id !== id);
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
    });

    $doc.on('change', '.crt_relationship_label_input', function () {
        const id = $(this).data('id');
        const registry = getRegistry();
        const rel = registry.relationships.find(r => r.id === id);
        if (rel) rel.label = $(this).val();
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
    });

    $doc.on('change', '.crt_add_relationship_type', function () {
        const $row = $(this).closest('.crt_add_relationship_row');
        populateRelationshipNameSelects($row, getRegistry());
        $row.find('.crt_add_relationship_label').toggle($(this).val() === 'other');
    });

    $doc.on('click', '.crt_add_relationship_btn', function () {
        const $row = $(this).closest('.crt_add_relationship_row');
        const added = addRelationshipManually(
            $row.find('.crt_add_relationship_type').val(),
            $row.find('.crt_add_relationship_name1').val(),
            $row.find('.crt_add_relationship_name2').val(),
            $row.find('.crt_add_relationship_label').val(),
        );
        if (added) {
            $row.find('.crt_add_relationship_name1, .crt_add_relationship_name2, .crt_add_relationship_label').val('');
        }
    });

    $doc.on('click', '.crt_relationship_conflict_accept', function () {
        resolveRelationshipConflict($(this).data('id'), true);
    });
    $doc.on('click', '.crt_relationship_conflict_reject', function () {
        resolveRelationshipConflict($(this).data('id'), false);
    });

    // Settings-drawer-only controls (unique ids, so no delegation collision risk)
    $doc.on('change', '#crt_enabled', function () {
        getSettings().enabled = $(this).is(':checked');
        updateInjection();
    });
    $doc.on('change', '#crt_auto_extract', function () {
        getSettings().autoExtract = $(this).is(':checked');
    });
    $doc.on('change', '#crt_extract_every_n', function () {
        getSettings().extractEveryN = Number($(this).val()) || defaultSettings.extractEveryN;
    });
    $doc.on('change', '#crt_extraction_window', function () {
        getSettings().extractionWindow = Number($(this).val()) || defaultSettings.extractionWindow;
    });
    $doc.on('change', '#crt_injection_depth', function () {
        getSettings().injectionDepth = Number($(this).val()) || defaultSettings.injectionDepth;
        updateInjection();
    });
    $doc.on('change', '#crt_critical_facts_depth', function () {
        getSettings().criticalFactsDepth = Number($(this).val()) || defaultSettings.criticalFactsDepth;
        updateInjection();
    });
    $doc.on('change', '#crt_fallback_response_length', function () {
        getSettings().fallbackResponseLength = Number($(this).val()) || defaultSettings.fallbackResponseLength;
    });
    $doc.on('change', '#crt_kobold_url', function () {
        getSettings().koboldBaseUrl = $(this).val().trim();
    });
    $doc.on('change', '#crt_kobold_max_context', function () {
        getSettings().koboldMaxContext = Number($(this).val()) || defaultSettings.koboldMaxContext;
    });
    $doc.on('change', '#crt_kobold_max_length', function () {
        getSettings().koboldMaxLength = Number($(this).val()) || defaultSettings.koboldMaxLength;
    });

    // Floating window controls
    $doc.on('click', '#crt_toggle_button', function () {
        toggleFloatingPanel();
    });
    $doc.on('click', '#crt_floating_close', function () {
        setFloatingPanelOpen(false);
    });
}

function addEntityManually(rawName) {
    const name = String(rawName || '').trim();
    if (!name) return;

    const registry = getRegistry();
    if (registry.entities[name]) {
        setStatus(`"${name}" is already in the registry — edit their fields below instead.`, 'error');
        return;
    }

    ensureEntity(registry, name);
    saveRegistry(registry);
    renderEntityList();
    setStatus(`Added "${name}" manually. Fill in fields below, or wait for the next extraction pass to fill in what it can.`, 'ok');
}

// Manual entry always wins outright — locks only guard against extraction's
// own (fallible) guesses, never against something you typed in yourself.
function upsertRelationshipManually(registry, rel) {
    const key = relationshipKey(rel);
    const idx = registry.relationships.findIndex(r => relationshipKey(r) === key);
    if (idx === -1) {
        registry.relationships.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...rel, locked: false });
    } else {
        registry.relationships[idx] = { ...registry.relationships[idx], ...rel };
    }
}

function addRelationshipManually(type, rawName1, rawName2, rawLabel) {
    const registry = getRegistry();

    if (!RELATIONSHIP_TYPES.includes(type)) {
        setStatus('Pick a relationship type first.', 'error');
        return false;
    }
    if (!String(rawName1 || '').trim() || !String(rawName2 || '').trim()) {
        setStatus('Both names are needed to add a relationship.', 'error');
        return false;
    }

    const name1 = resolveEntityName(registry, rawName1);
    const name2 = resolveEntityName(registry, rawName2);
    if (!name1 || !name2) {
        const missing = [!name1 ? `"${rawName1}"` : null, !name2 ? `"${rawName2}"` : null].filter(Boolean).join(' and ');
        setStatus(`${missing} not found among tracked characters — check spelling, or add them above first.`, 'error');
        return false;
    }
    if (name1 === name2) {
        setStatus('A character can\'t have a relationship with themselves.', 'error');
        return false;
    }

    const rel = type === 'parent_child'
        ? { type, parent: name1, child: name2 }
        : type === 'other'
            ? { type, a: name1, b: name2, label: String(rawLabel || '').trim() || 'connected to' }
            : { type, a: name1, b: name2 };

    upsertRelationshipManually(registry, rel);
    saveRegistry(registry);
    updateInjection();
    renderEntityList();
    setStatus(`Added: ${relationshipSentence(rel)}`, 'ok');
    return true;
}

function resolveRelationshipConflict(id, accept) {
    const registry = getRegistry();
    const idx = registry.pendingRelationshipConflicts.findIndex(c => c.id === id);
    if (idx === -1) return;

    const conflict = registry.pendingRelationshipConflicts[idx];
    if (accept) {
        if (conflict.isNewContradictingEdge) {
            // The old locked edge was wrong — replace it with the proposed one.
            registry.relationships = registry.relationships.filter(r => r.id !== conflict.relationshipId);
            registry.relationships.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                ...conflict.proposedEdge,
                locked: false,
            });
        } else {
            const rel = registry.relationships.find(r => r.id === conflict.relationshipId);
            if (rel) rel.label = conflict.newLabel;
        }
    }

    registry.pendingRelationshipConflicts.splice(idx, 1);
    saveRegistry(registry);
    updateInjection();
    renderEntityList();
}

function resolveConflict(id, accept) {
    const registry = getRegistry();
    const idx = registry.pendingConflicts.findIndex(c => c.id === id);
    if (idx === -1) return;

    const conflict = registry.pendingConflicts[idx];
    if (accept) {
        const entity = ensureEntity(registry, conflict.entity);
        entity.fields[conflict.field] = conflict.newValue;
    }
    registry.pendingConflicts.splice(idx, 1);
    saveRegistry(registry);
    renderEntityList();
}

// ---------------------------------------------------------------------------
// UI — settings-drawer panel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UI — collapsible section shell used for every major block in both panels.
// Purely CSS-class-driven (crt_section_open) rather than JS-tracked state:
// these wrapper elements are only ever built once at mount (unlike per-
// character blocks, which get fully rebuilt on every render), so a toggled
// class here survives every subsequent renderEntityList() call for free.
// ---------------------------------------------------------------------------
function sectionHtml(title, bodyHtml, { startOpen = false, badgeHtml = '' } = {}) {
    return `
        <div class="crt_section${startOpen ? ' crt_section_open' : ''}">
            <div class="crt_section_header">
                <span class="crt_section_chevron fa-solid fa-chevron-right"></span>
                <span class="crt_section_title">${title}</span>
                ${badgeHtml}
            </div>
            <div class="crt_section_body">
                ${bodyHtml}
            </div>
        </div>`;
}

function worldNotesBodyHtml() {
    return `
                <p class="crt_hint">Freeform — nothing here is ever touched by extraction. Write it yourself, lock it to prevent accidental edits, unlock to update when something important changes. Injected at the highest-priority position (alongside the scenario), not the rolling chat depth used for tracked characters.</p>
                <textarea class="text_pole crt_world_notes_input" rows="4" placeholder="e.g. Setting: Ancient Greece, 430 BCE. City: Athens."></textarea>
                <label class="checkbox_label crt_world_notes_lock_label">
                    <input type="checkbox" class="crt_world_notes_lock" />
                    Lock (prevent edits)
                </label>`;
}

function relationshipsBodyHtml() {
    const typeOptionsHtml = RELATIONSHIP_TYPES
        .map(t => `<option value="${t}">${escapeHtml(RELATIONSHIP_TYPE_LABELS[t])}</option>`)
        .join('');
    return `
                <p class="crt_hint">How tracked characters relate to EACH OTHER — not to {{user}} (that's still each character's own "relationship_to_user" field). One shared entry per relationship rather than a copy on each side, so there's nothing for two cards to contradict. Lock a relationship to protect it — a later proposal that disagrees (a changed label, or a new, contradicting parent/spouse) is queued below instead of applied silently.</p>
                <div class="crt_relationship_conflict_list_target"></div>
                <div class="crt_relationship_list_target"></div>
                <div class="crt_add_relationship_row">
                    <select class="text_pole crt_add_relationship_type">${typeOptionsHtml}</select>
                    <select class="text_pole crt_add_relationship_name1"></select>
                    <select class="text_pole crt_add_relationship_name2"></select>
                    <input type="text" class="text_pole crt_add_relationship_label" placeholder="Label (e.g. mentor of)" />
                    <button class="menu_button crt_add_relationship_btn">Add relationship</button>
                </div>`;
}

function trackedCharactersBodyHtml() {
    return `
                <div class="crt_add_entity_row">
                    <input type="text" class="text_pole crt_add_entity_input" placeholder="Character name (if a scan missed them)" />
                    <button class="menu_button crt_add_entity_btn">Add character</button>
                </div>
                <a href="#" class="crt_export_json_link">Data-only JSON</a>
                <div class="crt_conflict_list_target"></div>
                <div class="crt_entity_list_target"></div>`;
}

const RELATIONSHIP_BADGE_HTML = '<span class="crt_badge crt_badge_relationship_count"></span><span class="crt_badge crt_badge_warn crt_badge_relationship_conflict_flag"></span>';
const CHARACTERS_BADGE_HTML = '<span class="crt_badge crt_badge_character_count"></span><span class="crt_badge crt_badge_warn crt_badge_conflict_flag"></span>';

function settingsPanelHtml() {
    const settings = getSettings();
    const settingsBody = `
                <label class="checkbox_label">
                    <input type="checkbox" id="crt_enabled" ${settings.enabled ? 'checked' : ''} />
                    Enabled (inject registry into context)
                </label>
                <label class="checkbox_label">
                    <input type="checkbox" id="crt_auto_extract" ${settings.autoExtract ? 'checked' : ''} />
                    Auto-extract periodically
                </label>
                <div class="crt_setting_row">
                    <label for="crt_extract_every_n">Extract every N messages</label>
                    <input type="number" id="crt_extract_every_n" class="text_pole" min="5" value="${settings.extractEveryN}" />
                </div>
                <div class="crt_setting_row">
                    <label for="crt_extraction_window">Messages sent per extraction pass</label>
                    <input type="number" id="crt_extraction_window" class="text_pole" min="5" value="${settings.extractionWindow}" />
                </div>
                <div class="crt_setting_row">
                    <label for="crt_injection_depth">Injection depth (Author's-Note-style)</label>
                    <input type="number" id="crt_injection_depth" class="text_pole" min="0" value="${settings.injectionDepth}" />
                </div>
                <div class="crt_setting_row">
                    <label for="crt_critical_facts_depth" title="Deliberately closer than the main injection depth above — see README">Critical constraints depth</label>
                    <input type="number" id="crt_critical_facts_depth" class="text_pole" min="0" value="${settings.criticalFactsDepth}" />
                </div>
                <div class="crt_setting_row">
                    <label for="crt_fallback_response_length">Extraction response length (tokens, non-grammar path)</label>
                    <input type="number" id="crt_fallback_response_length" class="text_pole" min="128" value="${settings.fallbackResponseLength}" />
                </div>
                <p class="crt_hint">Independent of your main "Response (tokens)" setting — a full JSON registry dump usually needs more room than a normal chat reply. If extraction fails with NO_JSON/BAD_JSON, raise this rather than your main response length.</p>

                <h4>Grammar-constrained extraction (optional, recommended)</h4>
                <p class="crt_hint">Fill this in to force syntactically-valid JSON via KoboldCPP's grammar support (v1.44+) — eliminates most extraction parse failures. Leave blank to use the normal connection with an automatic repair retry instead.</p>
                <div class="crt_setting_row">
                    <label for="crt_kobold_url">KoboldCPP API URL</label>
                    <input type="text" id="crt_kobold_url" class="text_pole" placeholder="http://127.0.0.1:5001" value="${settings.koboldBaseUrl}" />
                </div>
                <div class="crt_setting_row">
                    <label for="crt_kobold_max_context">Max context (tokens)</label>
                    <input type="number" id="crt_kobold_max_context" class="text_pole" min="512" value="${settings.koboldMaxContext}" />
                </div>
                <div class="crt_setting_row">
                    <label for="crt_kobold_max_length">Max response length (tokens)</label>
                    <input type="number" id="crt_kobold_max_length" class="text_pole" min="64" value="${settings.koboldMaxLength}" />
                </div>`;

    return `
    <div id="crt_panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Character Registry Tracker</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <button class="menu_button crt_rescan_btn">Rescan now</button>
                <div class="crt_status crt_status_target"></div>

                ${sectionHtml('Tracked characters', trackedCharactersBodyHtml(), { startOpen: true, badgeHtml: CHARACTERS_BADGE_HTML })}
                ${sectionHtml('Relationships', relationshipsBodyHtml(), { startOpen: false, badgeHtml: RELATIONSHIP_BADGE_HTML })}
                ${sectionHtml('World notes', worldNotesBodyHtml(), { startOpen: true })}
                ${sectionHtml('Settings &amp; connection', settingsBody, { startOpen: false })}
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// UI — floating draggable window (quick access for mid-chat edits)
// ---------------------------------------------------------------------------

function floatingPanelHtml() {
    return `
    <div id="crt_floating_panel">
        <div id="crt_floating_header">
            <span>Character Registry</span>
            <div id="crt_floating_close" class="fa-solid fa-xmark interactable" title="Close"></div>
        </div>
        <div id="crt_floating_body">
            <button class="menu_button crt_rescan_btn">Rescan now</button>
            <div class="crt_status crt_status_target"></div>

            ${sectionHtml('Tracked characters', trackedCharactersBodyHtml(), { startOpen: true, badgeHtml: CHARACTERS_BADGE_HTML })}
            ${sectionHtml('Relationships', relationshipsBodyHtml(), { startOpen: false, badgeHtml: RELATIONSHIP_BADGE_HTML })}
            ${sectionHtml('World notes', worldNotesBodyHtml(), { startOpen: true })}
        </div>
    </div>`;
}

function toggleFloatingPanel() {
    const settings = getSettings();
    setFloatingPanelOpen(!settings.floatingPanelOpen);
}

function setFloatingPanelOpen(open) {
    const settings = getSettings();
    settings.floatingPanelOpen = open;
    $('#crt_floating_panel').toggle(open);
    if (open) {
        renderEntityList();
    }
}

function makeFloatingPanelDraggable() {
    const $panel = $('#crt_floating_panel');
    const $header = $('#crt_floating_header');
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    $header.on('mousedown', function (e) {
        dragging = true;
        const offset = $panel.offset();
        offsetX = e.pageX - offset.left;
        offsetY = e.pageY - offset.top;
        e.preventDefault();
    });

    $(document).on('mousemove', function (e) {
        if (!dragging) return;
        const top = e.pageY - offsetY;
        const left = e.pageX - offsetX;
        $panel.css({ top: `${top}px`, left: `${left}px` });
    });

    $(document).on('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        const settings = getSettings();
        settings.floatingPanelPos = { top: parseInt($panel.css('top')), left: parseInt($panel.css('left')) };
    });
}

function injectToolbarButton(attemptsLeft = 20) {
    if ($('#crt_toggle_button').length) return;
    const $target = $('#rightSendForm');
    if ($target.length === 0) {
        if (attemptsLeft <= 0) {
            console.warn('[Character Registry Tracker] Could not find #rightSendForm after several attempts — toolbar button not attached. The settings-drawer panel still works.');
            return;
        }
        setTimeout(() => injectToolbarButton(attemptsLeft - 1), 500);
        return;
    }
    const $btn = $('<div id="crt_toggle_button" class="fa-solid fa-address-card interactable" title="Character Registry"></div>');
    $target.prepend($btn);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function init() {
    const settings = getSettings();

    $('#extensions_settings2').append(settingsPanelHtml());
    $('body').append(floatingPanelHtml());

    if (settings.floatingPanelPos) {
        $('#crt_floating_panel').css({
            top: `${settings.floatingPanelPos.top}px`,
            left: `${settings.floatingPanelPos.left}px`,
        });
    }
    $('#crt_floating_panel').toggle(!!settings.floatingPanelOpen);

    injectToolbarButton();
    makeFloatingPanelDraggable();
    bindEntityListEvents();
    renderEntityList();
    updateInjection();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setStatus('', 'info');
        renderEntityList();
        updateInjection();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        renderEntityList();
        checkAutoExtract();
    });

    eventSource.on(event_types.GENERATION_STARTED, (type) => {
        // "quiet" covers background calls — ours (extraction) and anyone
        // else's. None of those are what this guard needs to protect
        // against; only real foreground chat generation counts.
        if (type === 'quiet') return;
        mainGenerationActive = true;
        mainGenerationStartedAt = Date.now();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        mainGenerationActive = false;
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        mainGenerationActive = false;
    });
}
