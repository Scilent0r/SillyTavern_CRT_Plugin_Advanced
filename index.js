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
import { eventSource, event_types, extension_prompt_roles } from '../../../../script.js';

const MODULE_NAME = 'character_registry_tracker';
const EXT_PROMPT_KEY = 'CRT_REGISTRY_BLOCK';

// Purely cosmetic grouping for the UI — behaves identically either way.
const IDENTITY_FIELDS = ['name', 'sex', 'pronouns', 'species', 'height'];
const STATE_FIELDS = ['relationship_to_user', 'weight', 'status', 'key_facts'];
const ALL_FIELDS = [...IDENTITY_FIELDS, ...STATE_FIELDS];
const ARRAY_FIELDS = ['key_facts'];

const defaultSettings = {
    enabled: true,
    autoExtract: true,
    extractEveryN: 30,       // messages since last extraction before auto-firing
    extractionWindow: 40,    // how many recent messages get sent to the extractor
    injectionDepth: 1,       // depth 0-2 stays closest to the strongest-attention zone (see README)
    injectionRole: extension_prompt_roles.SYSTEM,
    floatingPanelOpen: false,
    floatingPanelPos: null,  // { top, left } in px, persisted across sessions
    koboldBaseUrl: '',       // e.g. http://127.0.0.1:5001 — leave blank to skip grammar mode
    koboldMaxContext: 8192,
    koboldMaxLength: 512,
};

// A GBNF grammar that structurally forces the output to be exactly
// {"updates": {"<name>": {<any valid JSON object>}, ...}}. The outer shape
// is locked; per-character field objects stay generically JSON-valid (any
// keys/values) so we don't have to hand-encode every field name into the
// grammar and risk it going stale as fields change.
const JSON_SHAPE_GRAMMAR = `
root    ::= "{" ws "\\"updates\\"" ws ":" ws updates ws "}" ws
updates ::= "{" ws (pair ("," ws pair)*)? "}" ws
pair    ::= string ":" ws fields
fields  ::= "{" ws (fpair ("," ws fpair)*)? "}" ws
fpair   ::= string ":" ws value

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
        };
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

    return [
        'You maintain a structured fact registry about the characters in a roleplay chat.',
        'Below is the current registry (may be empty) and a recent slice of the chat transcript.',
        '',
        'Return ONLY a JSON object, no prose, no code fences, in this exact shape:',
        '{',
        '  "updates": {',
        '    "<character name>": {',
        `      "name": "...", "sex": "...", "pronouns": "...", "species": "...", "height": "...",`,
        `      "relationship_to_user": "...", "weight": "...", "status": "...", "key_facts": ["..."]`,
        '    }',
        '  }',
        '}',
        '',
        'Rules:',
        '- For each character who appears in this transcript slice, include your best current understanding of every field you have information for — whether or not the registry already has a value for it. It is fine (and expected) to re-state a field that has not changed.',
        '- Omit a field entirely if the transcript gives no information about it, rather than guessing.',
        '- Only include characters who actually appear in this transcript slice.',
        '',
        '### Current registry',
        JSON.stringify(currentRegistry, null, 2),
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

            const proposed = ARRAY_FIELDS.includes(field) && !Array.isArray(data[field])
                ? [data[field]]
                : data[field];
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

// Error codes, in the order a run can hit them. Each has a fixed, specific
// user-facing message plus a concrete next step — never just "failed".
const ERROR_CODES = {
    NO_CHAT: {
        message: 'No chat messages yet',
        hint: 'Send or receive at least one message first, then Rescan.',
    },
    GENERATION_IN_PROGRESS: {
        message: 'The main chat is still generating a reply',
        hint: 'Wait for the current response to finish before Rescanning — KoboldCPP can only serve one generation at a time.',
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
    return await context.generateQuietPrompt({ quietPrompt: prompt });
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
    if (mainGenerationActive) {
        if (manual) reportError('GENERATION_IN_PROGRESS');
        return;
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

    try {
        registry.lastExtractedIndex = chat.length;
        saveRegistry(registry);
    } catch (err) {
        reportError('SAVE_FAILED', err);
        return;
    }

    updateInjection();
    renderEntityList();
    setStatus(`✓ Registry updated (${touched} character(s) touched).`, 'ok');
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

    const identityBits = [f.pronouns, f.species, f.height].filter(Boolean);
    if (identityBits.length) parts.push(identityBits.join(', '));

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

function buildInjectionText(registry) {
    const lines = Object.entries(registry.entities)
        .filter(([, entity]) => entity.included && hasAnyField(entity))
        .map(([name, entity]) => formatEntityLine(name, entity));

    if (lines.length === 0) return '';

    return ['[Character Registry]', ...lines, '[/Character Registry]'].join('\n');
}

function updateInjection() {
    const settings = getSettings();
    const context = getContext();
    const registry = getRegistry();

    if (!settings.enabled) {
        context.setExtensionPrompt(EXT_PROMPT_KEY, '', 1, settings.injectionDepth, false, settings.injectionRole);
        return;
    }

    const text = buildInjectionText(registry);
    // position 1 === extension_prompt_types.IN_CHAT (same mechanism Author's Note uses)
    context.setExtensionPrompt(EXT_PROMPT_KEY, text, 1, settings.injectionDepth, false, settings.injectionRole);
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
    const displayValue = Array.isArray(value) ? value.join('; ') : (value ?? '');
    return `
        <div class="crt_field_row">
            <label for="${inputId}">${escapeHtml(field)}</label>
            <input type="text" id="${inputId}" class="text_pole crt_field_input"
                data-entity="${safeEntity}" data-field="${escapeHtml(field)}"
                value="${escapeHtml(displayValue)}" />
            <label class="checkbox_label crt_lock_label" title="Lock: protects this field from silent overwrite. A later proposed change is queued as a conflict instead of applied.">
                <input type="checkbox" class="crt_lock_toggle"
                    data-entity="${safeEntity}" data-field="${escapeHtml(field)}"
                    ${locked ? 'checked' : ''} />
                lock
            </label>
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

function entityBlockHtml(name, entity) {
    const safeName = escapeHtml(name);
    const identityRows = IDENTITY_FIELDS
        .map(f => fieldRowHtml(name, f, entity.fields[f], !!entity.locks[f]))
        .join('');
    const stateRows = STATE_FIELDS
        .map(f => fieldRowHtml(name, f, entity.fields[f], !!entity.locks[f]))
        .join('');

    return `
        <div class="crt_entity_block" data-entity="${safeName}">
            <div class="crt_entity_header">
                <strong>${safeName}</strong>
                <label class="checkbox_label">
                    <input type="checkbox" class="crt_include_toggle" data-entity="${safeName}"
                        ${entity.included ? 'checked' : ''} />
                    include in context
                </label>
                <button class="menu_button crt_delete_entity" data-entity="${safeName}">Delete</button>
            </div>
            <div class="crt_field_group"><em>Identity</em>${identityRows}</div>
            <div class="crt_field_group"><em>Story state</em>${stateRows}</div>
        </div>`;
}

function buildEntityListHtml(registry) {
    const names = Object.keys(registry.entities).sort();
    if (names.length === 0) {
        return '<div class="crt_empty">No characters tracked yet. Send some messages or hit Rescan.</div>';
    }
    return names.map(name => entityBlockHtml(name, registry.entities[name])).join('');
}

function buildConflictListHtml(registry) {
    if (registry.pendingConflicts.length === 0) {
        return '<div class="crt_empty">No pending conflicts on locked fields.</div>';
    }
    return registry.pendingConflicts.map(conflictRowHtml).join('');
}

function renderEntityList() {
    const registry = getRegistry();
    const active = document.activeElement;
    const isEditingField = active && (
        active.classList.contains('crt_field_input') || active.classList.contains('crt_add_entity_input')
    );

    // Don't nuke an input the user is actively typing in — a background
    // auto-extraction pass finishing mid-edit shouldn't wipe their keystrokes.
    // The conflict list is unrelated DOM, so it's always safe to refresh.
    $('.crt_conflict_list_target').html(buildConflictListHtml(registry));
    if (isEditingField) return;

    $('.crt_entity_list_target').html(buildEntityListHtml(registry));
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

        entity.fields[field] = ARRAY_FIELDS.includes(field)
            ? value.split(';').map(s => s.trim()).filter(Boolean)
            : value;

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
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
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

    $doc.on('click', '.crt_add_entity_btn', function () {
        const $input = $(this).siblings('.crt_add_entity_input');
        addEntityManually($input.val());
        $input.val('');
    });
    $doc.on('keydown', '.crt_add_entity_input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            addEntityManually($(this).val());
            $(this).val('');
        }
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

function settingsPanelHtml() {
    const settings = getSettings();
    return `
    <div id="crt_panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Character Registry Tracker</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
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
                </div>

                <button class="menu_button crt_rescan_btn">Rescan now</button>
                <div class="crt_status crt_status_target"></div>

                <h4>Tracked characters</h4>
                <div class="crt_add_entity_row">
                    <input type="text" class="text_pole crt_add_entity_input" placeholder="Character name (if a scan missed them)" />
                    <button class="menu_button crt_add_entity_btn">Add character</button>
                </div>
                <div class="crt_entity_list_target"></div>

                <h4>Pending conflicts on locked fields</h4>
                <div class="crt_conflict_list_target"></div>
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
            <div class="crt_add_entity_row">
                <input type="text" class="text_pole crt_add_entity_input" placeholder="Character name (if a scan missed them)" />
                <button class="menu_button crt_add_entity_btn">Add character</button>
            </div>
            <div class="crt_entity_list_target"></div>
            <h4>Pending conflicts on locked fields</h4>
            <div class="crt_conflict_list_target"></div>
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

    eventSource.on(event_types.GENERATION_STARTED, () => {
        mainGenerationActive = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        mainGenerationActive = false;
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        mainGenerationActive = false;
    });
}
