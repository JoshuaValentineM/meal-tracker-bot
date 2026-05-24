# Meal Tracker Bot Behavior Guide

This file explains how the bot currently works so a future agent can quickly understand the existing behavior before making changes.

## Current Entry Point

- Main startup file: `src/index.ts`
- Main WhatsApp logic: `src/services/whatsapp.ts`
- AI placeholder service: `src/services/ai.ts`

## High-Level Flow

1. The app starts from `src/index.ts`.
2. Environment variables are loaded with `dotenv`.
3. A `WhatsAppService` instance is created.
4. `WhatsAppService.initialize()` starts the WhatsApp client.
5. The bot listens for WhatsApp lifecycle events and incoming messages.

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

- `qr`: when a QR code must be scanned
- `authenticated`: when WhatsApp accepts the login
- `loading_screen`: when the web client is still loading
- `change_state`: when the WhatsApp connection state changes
- `ready`: when the bot is fully online and ready to process chats
- `disconnected`: when the session disconnects
- `message_create`: logs created messages
- `message`: logs incoming messages that the bot receives

## Message Filtering Rules

All message handling currently goes through `handleIncomingMessage()` inside `src/services/whatsapp.ts`.

The bot applies these filters in order:

1. It checks whether the chat is a group.
2. If the environment variable `TARGET_GROUP_NAME` is set, it only accepts messages from that exact group name.
3. If the message starts with `!log`, it replies with a text-processing placeholder.
4. If the message contains media, it replies with an image-processing placeholder.

### Group-Only Behavior

This line makes the bot ignore direct messages:

```ts
if (!chat.isGroup) {
  return;
}
```

So the bot currently does not respond in one-to-one chats.

### Specific Group Lock

This is controlled by:

```ts
this.targetGroupName = process.env.TARGET_GROUP_NAME?.trim() || null;
```

And then:

```ts
if (this.targetGroupName && chat.name !== this.targetGroupName) {
  return;
}
```

Meaning:

- If `TARGET_GROUP_NAME` is set, the bot only responds in that exact group.
- If `TARGET_GROUP_NAME` is empty or missing, the bot can respond in any group.

Example:

```env
TARGET_GROUP_NAME=Our Food Journal
```

With that config, the bot responds in `Our Food Journal` and ignores a different group such as `Try`.

## Supported Behaviors Right Now

### Text Command

If a group message starts with `!log`, the bot does this:

- strips the `!log` prefix
- checks whether any food text remains
- replies with a confirmation placeholder such as:

```text
📝 Processing text entry: "Nasi Ayam"...
```

If the message is only `!log`, it replies with a validation hint.

### Image Message

If a valid group message has media attached, the bot replies with:

```text
📸 Food photo detected! Analyzing nutrients, hold tight...
```

This is still a placeholder and is not yet connected to the AI service.

## What The AI Service Does Today

`src/services/ai.ts` is only a starter file right now.

Current state:

- it checks whether `GEMINI_API_KEY` exists
- it exposes `isConfigured()`
- it has a placeholder `estimateFromText()` method
- it does not yet process real food text or images

So the WhatsApp bot is currently working as a WhatsApp listener and responder, but not yet as a real nutrition analysis bot.

## Current Environment Variables

Known variables used right now:

- `GEMINI_API_KEY`
- `TARGET_GROUP_NAME`

## Current Dev Commands

From the project root:

```bash
rtk npm run dev
rtk npm run build
```

## Important Current Limitation

The bot is not yet doing real nutrition extraction.

Current status:

- WhatsApp connection works
- group filtering works
- command detection works
- image detection works
- Gemini nutrition analysis is not wired in yet

## Suggested Use For Future Agents

Before changing behavior, a future agent should check:

1. Whether `TARGET_GROUP_NAME` is set in `.env`
2. Whether the user wants one-group behavior or multi-group behavior
3. Whether the user wants DM support in addition to group support
4. Whether AI text parsing or image parsing should be implemented next
