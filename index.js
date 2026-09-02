// Character Registry Tracker (CCT v2)
// Auto-maintained per-character fact registry that survives KoboldCPP/SillyTavern
// reboots by living in chat metadata (saved to disk with the chat) instead of
// relying on the model's context window or hand-authored World Info entries.
//
// See README.md for the design rationale and the static/dynamic field split.

import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, extension_prompt_roles } from '../../../../script.js';

const MODULE_NAME = 'character_registry_tracker';
const EXT_PROMPT_KEY = 'CRT_REGISTRY_BLOCK';

const STATIC_FIELDS = ['name', 'sex', 'pronouns', 'species', 'height'];
const DYNAMIC_FIELDS = ['relationship_to_user', 'weight', 'status', 'key_facts'];

const defaultSettings = {
    enabled: true,
    autoExtract: true,
    extractEveryN: 30,       // messages since last extraction before auto-firing
    extractionWindow: 40,    // how many recent messages get sent to the extractor
    injectionDepth: 4,       // same idea as Author's Note depth
    injectionRole: extension_prompt_roles.SYSTEM,
};

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
        entities: {},          // name -> { static: {}, dynamic: {}, locks: {}, included: true }
        lastExtractedIndex: 0, // index into context.chat up to which we've extracted
        pendingConflicts: [],  // proposed static-field changes awaiting confirmation
    };
}

function getRegistry() {
    const context = getContext();
    const metadata = context.chatMetadata || {};
    const existing = metadata[MODULE_NAME];
    if (!existing) {
        return emptyRegistry();
    }
    // Defensive defaults in case of an older/partial saved shape.
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
            static: {},
            dynamic: {},
            locks: { static: false, dynamic: {} },
            included: true,
        };
    }
    return registry.entities[name];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(chatSlice, registry) {
    const transcript = chatSlice
        .map(m => `${m.name || (m.is_user ? 'User' : 'Assistant')}: ${m.mes}`)
        .join('\n');

    const currentRegistry = {};
    for (const [name, entity] of Object.entries(registry.entities)) {
        currentRegistry[name] = { static: entity.static, dynamic: entity.dynamic };
    }

    return [
        'You maintain a structured fact registry about the characters in a roleplay chat.',
        'Below is the current registry (may be empty) and a recent slice of the chat transcript.',
        '',
        'Return ONLY a JSON object, no prose, no code fences, in this exact shape:',
        '{',
        '  "updates": {',
        '    "<character name>": {',
        '      "dynamic": { "relationship_to_user": "...", "weight": "...", "status": "...", "key_facts": ["..."] }',
        '    }',
        '  },',
        '  "static_conflicts": {',
        '    "<character name>": { "<field>": { "old": "...", "new": "...", "reason": "..." } }',
        '  }',
        '}',
        '',
        'Rules:',
        `- Only include a "static" block (fields: ${STATIC_FIELDS.join(', ')}) for a character if it has NO existing static data yet.`,
        '- Never silently overwrite an existing static field. If the transcript contradicts one, put it under "static_conflicts" instead, and leave "updates" static-free for that character.',
        `- "dynamic" fields (${DYNAMIC_FIELDS.join(', ')}) should reflect the latest state from the transcript. Omit fields that did not change or are not mentioned.`,
        '- Only include characters who appear in this transcript slice.',
        '- Omit the "static_conflicts" key entirely if there are none.',
        '',
        '### Current registry',
        JSON.stringify(currentRegistry, null, 2),
        '',
        '### Recent transcript',
        transcript,
    ].join('\n');
}

function parseExtractionResult(rawText) {
    // Strip code fences if the model wrapped the JSON anyway.
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
        throw new Error('No JSON object found in extraction response');
    }
    return JSON.parse(match[0]);
}

function mergeExtractionResult(registry, result) {
    const updates = result.updates || {};
    for (const [name, data] of Object.entries(updates)) {
        const entity = ensureEntity(registry, name);

        // Static: only fill fields that are genuinely empty and unlocked.
        if (data.static && !entity.locks.static) {
            for (const field of STATIC_FIELDS) {
                if (data.static[field] && !entity.static[field]) {
                    entity.static[field] = data.static[field];
                }
            }
        }

        // Dynamic: overwrite unless the specific field is locked.
        if (data.dynamic) {
            for (const field of DYNAMIC_FIELDS) {
                if (data.dynamic[field] === undefined) continue;
                if (entity.locks.dynamic[field]) continue;
                entity.dynamic[field] = data.dynamic[field];
            }
        }
    }

    const conflicts = result.static_conflicts || {};
    for (const [name, fields] of Object.entries(conflicts)) {
        for (const [field, change] of Object.entries(fields)) {
            registry.pendingConflicts.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                entity: name,
                field,
                oldValue: change.old,
                newValue: change.new,
                reason: change.reason || '',
            });
        }
    }

    return registry;
}

async function runExtraction(manual = false) {
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat || [];
    const registry = getRegistry();

    if (!manual && !settings.autoExtract) return;
    if (chat.length === 0) return;

    const startIndex = Math.max(0, chat.length - settings.extractionWindow);
    const chatSlice = chat.slice(startIndex);

    if (chatSlice.length === 0) return;

    const prompt = buildExtractionPrompt(chatSlice, registry);
    setStatus('Extracting character facts…');

    try {
        const rawResult = await context.generateQuietPrompt({ quietPrompt: prompt });
        const parsed = parseExtractionResult(rawResult);
        mergeExtractionResult(registry, parsed);
        registry.lastExtractedIndex = chat.length;
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
        setStatus(`Registry updated (${Object.keys(parsed.updates || {}).length} character(s) touched).`);
    } catch (err) {
        console.error('[Character Registry Tracker] extraction failed:', err);
        setStatus('Extraction failed — see browser console for details.');
    }
}

async function checkAutoExtract() {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoExtract) return;

    const context = getContext();
    const chat = context.chat || [];
    const registry = getRegistry();

    if (chat.length - registry.lastExtractedIndex >= settings.extractEveryN) {
        await runExtraction(false);
    }
}

// ---------------------------------------------------------------------------
// Injection (Author's-Note-style: fixed depth, IN_CHAT position)
// ---------------------------------------------------------------------------

function formatEntityLine(name, entity) {
    const parts = [];
    const s = entity.static;
    const d = entity.dynamic;

    const staticBits = [s.pronouns, s.species, s.height].filter(Boolean);
    if (staticBits.length) parts.push(staticBits.join(', '));

    if (d.relationship_to_user) parts.push(`Relationship to {{user}}: ${d.relationship_to_user}`);
    if (d.status) parts.push(`Status: ${d.status}`);
    if (d.weight) parts.push(`Weight: ${d.weight}`);
    if (Array.isArray(d.key_facts) && d.key_facts.length) {
        parts.push(`Facts: ${d.key_facts.join('; ')}`);
    }

    return `${name}: ${parts.join('. ')}`;
}

function buildInjectionText(registry) {
    const lines = Object.entries(registry.entities)
        .filter(([, entity]) => entity.included)
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
// UI
// ---------------------------------------------------------------------------

function setStatus(text) {
    $('#crt_status').text(text);
}

function fieldRowHtml(entityName, group, field, value, locked) {
    const inputId = `crt_${group}_${entityName}_${field}`;
    const displayValue = Array.isArray(value) ? value.join('; ') : (value ?? '');
    return `
        <div class="crt_field_row">
            <label for="${inputId}">${field}</label>
            <input type="text" id="${inputId}" class="text_pole crt_field_input"
                data-entity="${entityName}" data-group="${group}" data-field="${field}"
                value="${$('<div>').text(displayValue).html()}" />
            <label class="checkbox_label crt_lock_label">
                <input type="checkbox" class="crt_lock_toggle"
                    data-entity="${entityName}" data-group="${group}" data-field="${field}"
                    ${locked ? 'checked' : ''} />
                lock
            </label>
        </div>`;
}

function conflictRowHtml(conflict) {
    return `
        <div class="crt_conflict_row" data-id="${conflict.id}">
            <strong>${conflict.entity}.${conflict.field}</strong>:
            "${conflict.oldValue}" → "${conflict.newValue}"
            ${conflict.reason ? `<div class="crt_conflict_reason">${conflict.reason}</div>` : ''}
            <button class="menu_button crt_conflict_accept" data-id="${conflict.id}">Accept</button>
            <button class="menu_button crt_conflict_reject" data-id="${conflict.id}">Reject</button>
        </div>`;
}

function entityBlockHtml(name, entity) {
    const staticRows = STATIC_FIELDS
        .map(f => fieldRowHtml(name, 'static', f, entity.static[f], entity.locks.static))
        .join('');
    const dynamicRows = DYNAMIC_FIELDS
        .map(f => fieldRowHtml(name, 'dynamic', f, entity.dynamic[f], !!entity.locks.dynamic[f]))
        .join('');

    return `
        <div class="crt_entity_block" data-entity="${name}">
            <div class="crt_entity_header">
                <strong>${name}</strong>
                <label class="checkbox_label">
                    <input type="checkbox" class="crt_include_toggle" data-entity="${name}"
                        ${entity.included ? 'checked' : ''} />
                    include in context
                </label>
                <button class="menu_button crt_delete_entity" data-entity="${name}">Delete</button>
            </div>
            <div class="crt_field_group"><em>Static</em>${staticRows}</div>
            <div class="crt_field_group"><em>Dynamic</em>${dynamicRows}</div>
        </div>`;
}

function renderEntityList() {
    const registry = getRegistry();
    const $list = $('#crt_entity_list');
    if ($list.length === 0) return;

    $list.empty();

    const names = Object.keys(registry.entities).sort();
    if (names.length === 0) {
        $list.append('<div class="crt_empty">No characters tracked yet. Send some messages or hit Rescan.</div>');
    } else {
        for (const name of names) {
            $list.append(entityBlockHtml(name, registry.entities[name]));
        }
    }

    const $conflicts = $('#crt_conflict_list');
    $conflicts.empty();
    if (registry.pendingConflicts.length === 0) {
        $conflicts.append('<div class="crt_empty">No pending static-field conflicts.</div>');
    } else {
        for (const conflict of registry.pendingConflicts) {
            $conflicts.append(conflictRowHtml(conflict));
        }
    }
}

function bindEntityListEvents() {
    const $list = $('#crt_panel');

    $list.on('change', '.crt_field_input', function () {
        const $el = $(this);
        const registry = getRegistry();
        const entity = ensureEntity(registry, $el.data('entity'));
        const group = $el.data('group');
        const field = $el.data('field');
        const value = $el.val();

        if (group === 'static') {
            entity.static[field] = value;
        } else if (field === 'key_facts') {
            entity.dynamic[field] = value.split(';').map(s => s.trim()).filter(Boolean);
        } else {
            entity.dynamic[field] = value;
        }

        saveRegistry(registry);
        updateInjection();
    });

    $list.on('change', '.crt_lock_toggle', function () {
        const $el = $(this);
        const registry = getRegistry();
        const entity = ensureEntity(registry, $el.data('entity'));
        const group = $el.data('group');
        const field = $el.data('field');
        const locked = $el.is(':checked');

        if (group === 'static') {
            entity.locks.static = locked;
        } else {
            entity.locks.dynamic[field] = locked;
        }
        saveRegistry(registry);
    });

    $list.on('change', '.crt_include_toggle', function () {
        const $el = $(this);
        const registry = getRegistry();
        const entity = ensureEntity(registry, $el.data('entity'));
        entity.included = $el.is(':checked');
        saveRegistry(registry);
        updateInjection();
    });

    $list.on('click', '.crt_delete_entity', function () {
        const name = $(this).data('entity');
        const registry = getRegistry();
        delete registry.entities[name];
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
    });

    $list.on('click', '.crt_conflict_accept', function () {
        resolveConflict($(this).data('id'), true);
    });
    $list.on('click', '.crt_conflict_reject', function () {
        resolveConflict($(this).data('id'), false);
    });

    $list.on('click', '#crt_rescan_btn', function () {
        runExtraction(true);
    });

    $list.on('change', '#crt_enabled', function () {
        getSettings().enabled = $(this).is(':checked');
        updateInjection();
    });
    $list.on('change', '#crt_auto_extract', function () {
        getSettings().autoExtract = $(this).is(':checked');
    });
    $list.on('change', '#crt_extract_every_n', function () {
        getSettings().extractEveryN = Number($(this).val()) || defaultSettings.extractEveryN;
    });
    $list.on('change', '#crt_extraction_window', function () {
        getSettings().extractionWindow = Number($(this).val()) || defaultSettings.extractionWindow;
    });
    $list.on('change', '#crt_injection_depth', function () {
        getSettings().injectionDepth = Number($(this).val()) || defaultSettings.injectionDepth;
        updateInjection();
    });
}

function resolveConflict(id, accept) {
    const registry = getRegistry();
    const idx = registry.pendingConflicts.findIndex(c => c.id === id);
    if (idx === -1) return;

    const conflict = registry.pendingConflicts[idx];
    if (accept) {
        const entity = ensureEntity(registry, conflict.entity);
        entity.static[conflict.field] = conflict.newValue;
    }
    registry.pendingConflicts.splice(idx, 1);
    saveRegistry(registry);
    renderEntityList();
}

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
                <button id="crt_rescan_btn" class="menu_button">Rescan now</button>
                <div id="crt_status" class="crt_status"></div>

                <h4>Tracked characters</h4>
                <div id="crt_entity_list"></div>

                <h4>Pending static-field conflicts</h4>
                <div id="crt_conflict_list"></div>
            </div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function init() {
    $('#extensions_settings2').append(settingsPanelHtml());
    bindEntityListEvents();
    renderEntityList();
    updateInjection();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderEntityList();
        updateInjection();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        renderEntityList();
        checkAutoExtract();
    });
}
