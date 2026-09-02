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
    injectionDepth: 4,       // same idea as Author's Note depth
    injectionRole: extension_prompt_roles.SYSTEM,
    floatingPanelOpen: false,
    floatingPanelPos: null,  // { top, left } in px, persisted across sessions
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
        const arrA = Array.isArray(a) ? a : [a];
        const arrB = Array.isArray(b) ? b : [b];
        return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
    }
    return a === b;
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

function parseExtractionResult(rawText) {
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
        throw new Error('No JSON object found in extraction response');
    }
    return JSON.parse(match[0]);
}

function mergeExtractionResult(registry, result) {
    const updates = result.updates || {};
    let touched = 0;

    for (const [name, data] of Object.entries(updates)) {
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
        const { touched } = mergeExtractionResult(registry, parsed);
        registry.lastExtractedIndex = chat.length;
        saveRegistry(registry);
        updateInjection();
        renderEntityList();
        setStatus(`Registry updated (${touched} character(s) touched).`);
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
// UI — shared markup builders (rendered into both the settings-drawer panel
// and the floating window; they stay in sync because both re-render on
// every registry change)
// ---------------------------------------------------------------------------

function setStatus(text) {
    $('.crt_status_target').text(text);
}

function fieldRowHtml(entityName, field, value, locked) {
    const inputId = `crt_field_${entityName}_${field}`;
    const displayValue = Array.isArray(value) ? value.join('; ') : (value ?? '');
    return `
        <div class="crt_field_row">
            <label for="${inputId}">${field}</label>
            <input type="text" id="${inputId}" class="text_pole crt_field_input"
                data-entity="${entityName}" data-field="${field}"
                value="${$('<div>').text(displayValue).html()}" />
            <label class="checkbox_label crt_lock_label" title="Lock: protects this field from silent overwrite. A later proposed change is queued as a conflict instead of applied.">
                <input type="checkbox" class="crt_lock_toggle"
                    data-entity="${entityName}" data-field="${field}"
                    ${locked ? 'checked' : ''} />
                lock
            </label>
        </div>`;
}

function conflictRowHtml(conflict) {
    const oldDisplay = Array.isArray(conflict.oldValue) ? conflict.oldValue.join('; ') : conflict.oldValue;
    const newDisplay = Array.isArray(conflict.newValue) ? conflict.newValue.join('; ') : conflict.newValue;
    return `
        <div class="crt_conflict_row" data-id="${conflict.id}">
            <strong>${conflict.entity}.${conflict.field}</strong> is locked at
            "${oldDisplay}" — extraction proposed "${newDisplay}".
            <button class="menu_button crt_conflict_accept" data-id="${conflict.id}">Accept new value</button>
            <button class="menu_button crt_conflict_reject" data-id="${conflict.id}">Keep locked value</button>
        </div>`;
}

function entityBlockHtml(name, entity) {
    const identityRows = IDENTITY_FIELDS
        .map(f => fieldRowHtml(name, f, entity.fields[f], !!entity.locks[f]))
        .join('');
    const stateRows = STATE_FIELDS
        .map(f => fieldRowHtml(name, f, entity.fields[f], !!entity.locks[f]))
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
    // Re-render every mounted instance (settings-drawer panel + floating window)
    // so both stay in sync regardless of which one triggered the change.
    $('.crt_entity_list_target').html(buildEntityListHtml(registry));
    $('.crt_conflict_list_target').html(buildConflictListHtml(registry));
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

    // Floating window controls
    $doc.on('click', '#crt_toggle_button', function () {
        toggleFloatingPanel();
    });
    $doc.on('click', '#crt_floating_close', function () {
        setFloatingPanelOpen(false);
    });
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
                <button class="menu_button crt_rescan_btn">Rescan now</button>
                <div class="crt_status crt_status_target"></div>

                <h4>Tracked characters</h4>
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

function injectToolbarButton() {
    if ($('#crt_toggle_button').length) return;
    const $target = $('#rightSendForm');
    if ($target.length === 0) {
        setTimeout(injectToolbarButton, 500);
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
        renderEntityList();
        updateInjection();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        renderEntityList();
        checkAutoExtract();
    });
}
