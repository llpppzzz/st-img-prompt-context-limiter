# Image Prompt Context Limit

A SillyTavern extension that trims the payload sent to the LLM when the built-in **Stable Diffusion** extension generates an image prompt (e.g. the **Last Message** mode).

Without this extension, "Last Message" image prompt generation sends the entire chat history plus character card, scenario, world info, jailbreak, and other system prompts to the LLM. This extension rewrites that request so only the image prompt template (system) and the last N chat messages are sent — which keeps the payload small, fast, and cheap.

## Features

- Configurable number of recent chat messages to include (1 / 3 / 5 / 10 / 20)
- The image prompt template is sent as the last message, after the chat history
- Character card, scenario, world info, jailbreak, dialogue examples, and other system prompts are skipped
- Safe auto-detection: only requests that look like image prompt generation are rewritten
- Simplified Chinese / Traditional Chinese UI translations

## Installation

1. Open SillyTavern and go to **Extensions** (the magic wand menu) → **Manage extensions**.
2. Switch to the **Install extension** tab.
3. Paste the GitHub repository URL:

   ```
   https://github.com/llpppzzz/st-img-prompt-context-limiter
   ```

4. Click **Install**, then **Enable** the extension.

## Usage

Open **Extensions** → **Image Generation** settings panel (the Stable Diffusion extension drawer). A new option, **Chat messages sent for prompt generation**, is injected right below "Minimal response prompt processing":

- Choose how many recent chat messages are kept (`1 (last message only)` by default)
- Set to **All messages** to disable rewriting and restore the default SillyTavern behavior

With `1 (last message only)`, the payload sent for "Last Message" image prompt generation looks like:

```json
[
  { "role": "assistant", "content": "<the last reply>" },
  { "role": "system", "content": "<image prompt template>" }
]
```

## How it works

- Listens to `GENERATION_STARTED`; when the generation is a quiet prompt (`type === 'quiet'`) whose text matches the built-in image prompt templates, it arms a rewrite.
- Listens to `CHAT_COMPLETION_PROMPT_READY`; if armed, it replaces the messages array in place with the last N non-system messages followed by the template system message.
- If system message squashing merges the template with other system prompts (e.g. a Chain-of-Thought prompt), the template content is rebuilt from the captured quiet prompt so only the template is kept.
- No built-in SillyTavern files are modified — everything happens at runtime, so it works on any instance just by installing the extension.

## Limitations

- Detection relies on the default prompt template text (e.g. "comma-delimited list", "portrait"). Heavily customized templates, or Free Mode with a plain trigger, may not be detected.
- Only applies to chat-completion (OpenAI-compatible) APIs, where the request payload contains a `messages` array.
- The Stable Diffusion extension must be installed (it is bundled with SillyTavern by default).
