import {
    eventSource,
    event_types,
    saveSettingsDebounced,
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
};

// Markers found in the default SillyTavern image prompt templates
const imagePromptMarkers = [
    'comma-delimited list',
    'comma-separated list',
    'keywords and phrases',
    'tags describing the appearance',
    'text prompt used to generate the image',
    'visual details included in the last chat message',
    'picture that contains',
    'exhaustive comma-separated list of tags',
    'detailed comma-delimited list of keywords',
    'portrait',
    'photograph',
];

// Set when the current quiet prompt generation looks like an image prompt request
let pendingImagePrompt = false;
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

function looksLikeImagePromptTemplate(text) {
    const lower = String(text ?? '').toLowerCase();
    return imagePromptMarkers.some(marker => lower.includes(marker));
}

function onGenerationStarted(type, options) {
    pendingImagePrompt = type === 'quiet' && looksLikeImagePromptTemplate(options?.quiet_prompt);
}

function onPromptReady(data) {
    if (!pendingImagePrompt || !data?.chat || !Array.isArray(data.chat)) {
        return;
    }

    pendingImagePrompt = false;

    const settings = getSettings();
    if (!settings.enabled || settings.limit <= 0) {
        return;
    }

    const chat = data.chat;
    const template = chat[chat.length - 1];

    // The image prompt template must be the last message (system role)
    if (!template || template.role !== 'system' || !looksLikeImagePromptTemplate(template.content)) {
        return;
    }

    const chatMessages = chat
        .slice(0, -1)
        .filter(m => m?.role !== 'system' && m?.content && String(m.content).trim());

    const newChat = [...chatMessages.slice(-settings.limit), template];

    // Mutate in place: prepareOpenAIMessages returns the same array reference
    chat.splice(0, chat.length, ...newChat);
}

function onGenerationEnded() {
    pendingImagePrompt = false;
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
