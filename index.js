import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

// Installed extensions live under scripts/extensions/third-party/<name>/
const EXTENSION_NAME = 'third-party/st-img-prompt-context-limiter';

const defaultSettings = {
    // Whether to rewrite image prompt generation requests at all
    enabled: true,
    // How many recent chat messages to keep (0 = keep all / no rewrite)
    limit: 1,
    // Log debugging information to the browser console
    debug: false,
};

// Set when the current quiet prompt generation looks like an image prompt request
let pendingImagePrompt = false;
// The actual image prompt template used for this generation (from the SD extension)
let pendingPromptText = '';
let settingsInjected = false;
let observer = null;

function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[EXTENSION_NAME][key] === undefined) {
            extension_settings[EXTENSION_NAME][key] = value;
        }
    }

    return extension_settings[EXTENSION_NAME];
}

function debugLog(...args) {
    if (getSettings().debug) {
        console.log('[ImagePromptContextLimit]', ...args);
    }
}

/**
 * Extracts plain text from a chat message content (string or content parts array).
 */
function messageContentText(message) {
    const content = message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(part => typeof part === 'string' ? part : (part?.text ?? '')).join(' ');
    }
    return '';
}

/**
 * Normalizes text for comparison: removes {{macros}} and {0} placeholders,
 * collapses whitespace and lowercases.
 */
function normalizePromptText(text) {
    const content = typeof text === 'string'
        ? text
        : Array.isArray(text)
            ? text.map(part => typeof part === 'string' ? part : (part?.text ?? '')).join(' ')
            : String(text ?? '');
    return content
        .replace(/\{\{[\s\S]*?\}\}/g, ' ')
        .replace(/\{0\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Reads the currently configured image prompt templates from the Stable Diffusion
 * extension settings. Returns an array of normalized template strings.
 */
function getImagePromptTemplates() {
    const prompts = extension_settings?.sd?.prompts;
    if (!prompts || typeof prompts !== 'object') {
        return [];
    }

    return Object.values(prompts)
        .map(p => normalizePromptText(p))
        .filter(t => t.length >= 10);
}

function commonPrefixLength(a, b) {
    let i = 0;
    const max = Math.min(a.length, b.length);
    while (i < max && a[i] === b[i]) {
        i++;
    }
    return i;
}

/**
 * Checks whether the quiet prompt is one of the currently configured image prompt
 * templates (matched dynamically, so custom templates are supported too).
 */
function isImagePromptQuietPrompt(text) {
    const normalized = normalizePromptText(text);
    if (!normalized) {
        return false;
    }

    const templates = getImagePromptTemplates();
    if (templates.length === 0) {
        return false;
    }

    return templates.some(t => normalized.startsWith(t) || t.startsWith(normalized) || commonPrefixLength(normalized, t) >= 20);
}

/**
 * Builds a distinctive, macro-free prefix of the template used to locate the
 * template message inside the payload.
 */
function getTemplateProbe(text) {
    const clean = String(text ?? '').trim();
    const special = clean.search(/\{\{|\{0\}/);
    const prefix = special === -1 ? clean : clean.slice(0, special);
    return prefix.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
}

function onGenerationStarted(type, options) {
    const quietPrompt = String(options?.quiet_prompt ?? '');
    const armed = type === 'quiet' && isImagePromptQuietPrompt(quietPrompt);
    pendingImagePrompt = armed;
    pendingPromptText = armed ? quietPrompt : '';
    debugLog('GENERATION_STARTED', { type, armed, prompt: quietPrompt.slice(0, 150) });
}

function onPromptReady(data) {
    const summary = data?.chat?.map(m => ({ role: m?.role, content: messageContentText(m).slice(0, 80) }));
    debugLog('CHAT_COMPLETION_PROMPT_READY', { pending: pendingImagePrompt, messages: summary });

    if (!pendingImagePrompt || !data?.chat || !Array.isArray(data.chat)) {
        return;
    }

    pendingImagePrompt = false;

    const settings = getSettings();
    if (!settings.enabled || settings.limit <= 0) {
        pendingPromptText = '';
        return;
    }

    const chat = data.chat;

    // Locate the image prompt template message by its actual content (the quiet
    // prompt used for this generation), not by position or hardcoded markers.
    // Other system messages (e.g. custom prompts inserted after the chat history)
    // are excluded instead of being mistaken for the template.
    const probe = getTemplateProbe(pendingPromptText);
    const templateText = pendingPromptText;
    pendingPromptText = '';
    debugLog('probe', probe);
    if (probe.length < 10) {
        return;
    }

    const template = [...chat].reverse().find(m => m?.role === 'system' && normalizePromptText(messageContentText(m)).includes(probe));
    debugLog('template found', !!template);
    if (!template) {
        return;
    }

    // When "squash system messages" is enabled, the template may be merged with
    // other system prompts (e.g. a Chain-of-Thought prompt) into a single system
    // message. Rebuild the template content from the captured quiet prompt so
    // only the image prompt template is kept in the payload.
    const templateMessage = {
        role: 'system',
        content: substituteParams(templateText),
    };

    const chatMessages = chat.filter(m => m !== template && m?.role !== 'system' && m?.content && messageContentText(m).trim());

    const newChat = [...chatMessages.slice(-settings.limit), templateMessage];

    debugLog('rewritten payload', newChat.map(m => ({ role: m?.role, content: messageContentText(m).slice(0, 80) })));

    // Mutate in place: prepareOpenAIMessages returns the same array reference
    chat.splice(0, chat.length, ...newChat);
}

function onGenerationEnded() {
    pendingImagePrompt = false;
    pendingPromptText = '';
}

async function injectSettings() {
    if (settingsInjected) {
        return;
    }

    // Inject the control into the built-in Stable Diffusion settings drawer,
    // right after the "Minimal response prompt processing" option.
    const anchor = document.querySelector('label[for="sd_minimal_prompt_processing"]');
    if (!anchor) {
        return;
    }

    settingsInjected = true;
    observer?.disconnect();

    const settings = getSettings();
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings', settings);
    const block = $(html);
    $(anchor).after(block);

    block.find('#ipl_limit').val(settings.limit);
    block.find('#ipl_limit').on('change', function () {
        getSettings().limit = Number($(this).val());
        saveSettingsDebounced();
    });

    block.find('#ipl_debug').prop('checked', settings.debug);
    block.find('#ipl_debug').on('change', function () {
        getSettings().debug = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
}

export function init() {
    getSettings();

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);

    // Wait for the Stable Diffusion settings panel to be rendered, then inject the control
    observer = new MutationObserver(() => injectSettings());
    observer.observe(document.body, { childList: true, subtree: true });
    injectSettings();
}
