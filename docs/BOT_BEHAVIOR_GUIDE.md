# Meal Tracker Bot Behavior Guide

This file explains how the bot works today so future agents can change it without re-discovering the behavior from scratch.

## Current Entry Point

- Main startup file: `src/index.ts`
- Main WhatsApp logic: `src/services/whatsapp.ts`
- Gemini nutrition service: `src/services/ai.ts`

## High-Level Flow

1. The app starts from `src/index.ts`.
2. Environment variables are loaded with `dotenv`.
3. A `WhatsAppService` instance is created.
4. `WhatsAppService.initialize()` starts the WhatsApp client.
5. The bot listens for WhatsApp lifecycle events and incoming messages.
6. When a supported message mentions the bot, it routes the message into text or image nutrition analysis.

## WhatsApp Authentication Flow

The bot uses `whatsapp-web.js` with `LocalAuth`.

What this means:

- On first login, the terminal shows a QR code.
- The bot phone scans that QR code using WhatsApp Business -> Linked Devices.
- The session is then stored locally in `.wwebjs_auth/`.
- After the first successful link, future runs usually do not need another QR scan unless the session is invalidated.

Related local folders:

- `.wwebjs_auth/`: stores session/auth state
- `.wwebjs_cache/`: stores browser/cache data used by the WhatsApp web client

## Lifecycle Logs

The bot currently logs these events:

- `qr`
- `authenticated`
- `auth_failure`
- `loading_screen`
- `change_state`
- `ready`
- `disconnected`
- `message_create`
- `message`

The `message_create` and `message` logs include:

- chat name
- message body
- whether media exists
- `mentionedIds`

Those mention logs became important during debugging because WhatsApp may emit mention IDs in `@lid` format.

## Message Filtering Rules

All message handling goes through `handleIncomingMessage()` inside `src/services/whatsapp.ts`.

The bot applies these filters in order:

1. It only handles group chats.
2. It ignores messages sent by itself.
3. It checks whether the bot was called either by:
   - a real WhatsApp `@mention`
   - a configured plain-text trigger alias such as `@Meal Tracker BOT`
4. If the message has media and the bot was called, it analyzes the image.
5. If the message is text and includes a supported command, it runs that command.

### Group-Only Behavior

This line keeps the bot out of one-to-one chats:

```ts
if (!chat.isGroup) {
  return;
}
```

So the bot currently does not respond in direct chats.

## Mention And Trigger Behavior

The bot no longer uses `TARGET_GROUP_NAME`.

Current strategy:

- it can work in any group
- it only reacts when explicitly called
- calling can happen through:
  - real WhatsApp `@mention`
  - plain-text alias matching from `BOT_TRIGGER_ALIASES`

### Why This Was Needed

During development, plain text such as `@Meal Tracker BOT !help` did not always register as a structured WhatsApp mention.

Also, real mention IDs could arrive in forms such as:

```text
mentions=["15565800402972@lid"]
```

So the bot now resolves mentions more defensively by comparing:

- direct serialized IDs
- normalized ID keys
- `lid` and phone-number mappings via `getContactLidAndPhone(...)`

This logic lives in `hasStructuredMention()`.

## Supported Commands

### `!help`

Example:

```text
@Meal Tracker BOT !help
```

Behavior:

- replies with usage instructions
- shows the available commands
- explains text logging and photo logging

### `!log`

Example:

```text
@Meal Tracker BOT !log 150g dada ayam panggang
```

Behavior:

- strips the command prefix
- sends the remaining text to Gemini
- replies with structured macro output

If no food text is provided, the bot replies with a usage hint.

## Photo Behavior

Photo analysis is now mention-driven and does not require `!log`.

All of these are valid:

```text
@Meal Tracker BOT
```

Sent as the caption of a photo.

```text
@Meal Tracker BOT !log
```

Also sent as the caption of a photo.

Behavior:

- once the bot is called in a media message
- it downloads the image from WhatsApp
- it sends the image to Gemini
- it replies with estimated food name, calories, protein, carbs, and fiber

Important nuance:

- for media-only mention captions, the command text may normalize to an empty string
- the bot now treats that as "mentioned image, analyze it"
- it does not treat that as "not mentioned"

## AI Service Behavior

`src/services/ai.ts` is now a real Gemini integration.

Current capabilities:

- checks whether `GEMINI_API_KEY` exists
- uses `@google/genai`
- supports text analysis
- supports image analysis
- requests structured JSON output with a schema
- normalizes numeric values to whole numbers

Structured fields returned:

- `foodName`
- `calories`
- `protein`
- `carbs`
- `fiber`

## Gemini Model Configuration

The model is configurable through `GEMINI_MODEL`.

Current default:

```env
GEMINI_MODEL=gemini-2.5-flash-lite
```

This default was chosen because it is a cheaper/free-tier-friendly multimodal model for development.

## Error Handling

The AI layer wraps Gemini failures in `AIServiceError` when possible.

Current special cases:

- `429`: quota exhausted or quota not active
- `401` or `403`: invalid API key or missing access
- empty Gemini response

The WhatsApp layer uses `getFriendlyErrorMessage()` so users see a useful reply instead of a generic failure.

This was added after the bot hit Gemini free-tier quota errors during live image tests.

## Response Format

Successful nutrition replies are formatted like this:

```text
🍽️ Nutrient Log Verified!
━━━━━━━━━━━━━━━━━━
📝 Menu: ...

🔥 Kalori: ... kcal
💪 Protein: ...g
🍞 Karbohidrat: ...g
🥗 Serat: ...g
━━━━━━━━━━━━━━━━━━
```

## Current Environment Variables

Known variables used now:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `BOT_TRIGGER_ALIASES`

Example:

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
BOT_TRIGGER_ALIASES=Meal Tracker BOT
```

## Current Dev Commands

From the project root:

```bash
rtk npm run dev
rtk npm run build
```

Note:

- repo-local shell commands should be prefixed with `rtk`

## Repo Hygiene

The repo now includes:

- `.gitignore`
- `.env.example`

Ignored local-only artifacts:

- `.env`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `dist/`
- `node_modules/`
- `docs/PROJECT_CONTEXT_AND_CHAT_HISTORY.md`

## Important Current Limitations

Current limitations still in place:

- no database or persistent nutrition log storage yet
- no daily goal tracking yet
- no dashboard yet
- no direct-message support
- nutrition output is still estimation, not verified food-label data
- Gemini quota and billing can still block analysis if the project has no usable quota

## Suggested Use For Future Agents

Before changing behavior, a future agent should check:

1. Whether the user wants group-only behavior to remain
2. Whether plain-text alias triggers should remain alongside true mentions
3. Whether DM support should be added
4. Whether image-only mention behavior should stay permissive
5. Whether the next milestone is database persistence, history, or daily summaries
