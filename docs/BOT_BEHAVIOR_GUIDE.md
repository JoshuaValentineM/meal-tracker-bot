# Meal Tracker Bot Behavior Guide

This file explains how the bot works today so future agents can change it without re-discovering the behavior from scratch.

## Current Entry Point

- Main startup file: `src/index.ts`
- Main WhatsApp logic: `src/services/whatsapp.ts`
- Gemini nutrition service: `src/services/ai.ts`
- Supabase meal log service: `src/services/mealLog.ts`
- Meal log domain types: `src/types/meal-log.ts`

## High-Level Flow

1. The app starts from `src/index.ts`.
2. Environment variables are loaded with `dotenv`.
3. A `WhatsAppService` instance is created.
4. `WhatsAppService.initialize()` starts a Baileys socket connection.
5. The bot listens for Baileys connection events and `messages.upsert`.
6. When a supported group message calls the bot, it routes the message into text or image nutrition analysis.
7. After Gemini returns macros, the bot saves a structured meal log to Supabase.
8. The bot replies in WhatsApp with the macro estimate and a save status.

## WhatsApp Authentication Flow

The bot now uses `@whiskeysockets/baileys` instead of `whatsapp-web.js`.

What this means:

- there is no browser automation layer anymore
- there is no Puppeteer/Chromium dependency anymore
- WhatsApp Web is accessed through a WebSocket transport
- the login state is stored with Baileys multi-file auth

Auth storage:

- `.baileys_auth/`: stores Baileys session/auth state

The current initialization also supports Render-friendly credential injection:

- if `SESSION_CREDS_JSON` exists
- and `.baileys_auth/creds.json` does not exist yet
- the app writes `creds.json` automatically before calling `useMultiFileAuthState(...)`

This is meant to reduce friction on ephemeral filesystems like Render free tier.

## Lifecycle Logs

The bot currently logs these runtime events:

- `Connecting to WhatsApp via Baileys...`
- QR rendering when login is required
- successful connection open
- connection close errors
- reconnect attempts
- per-message logs

Message logs include:

- `fromMe`
- whether the chat is a group
- chat JID
- message body
- whether media exists
- `mentions`

These logs are important because Baileys can expose mentions in `@lid` format.

## Message Filtering Rules

All message handling goes through `handleIncomingMessage()` inside `src/services/whatsapp.ts`.

The bot applies these filters in order:

1. It only handles group chats.
2. It ignores messages sent by itself.
3. By default, it can respond in any group.
4. If `TARGET_GROUP_NAME` is set, it only handles that exact group subject.
5. It checks whether the bot was called either by:
   - a real WhatsApp `@mention`
   - a configured plain-text trigger alias such as `@Meal Tracker BOT`
6. If the message has media and the bot was called, it analyzes the image.
7. If the message is text and includes a supported command, it runs that command.

### Group-Only Behavior

The bot currently does not respond in direct chats.

### Optional Group Lock

The bot can still be restricted to one exact group by subject if needed later:

```env
TARGET_GROUP_NAME=Our Food Journal
```

Default:

```env
TARGET_GROUP_NAME=
```

With the default empty value, the bot can respond in any group where it is called by mention or trigger alias.

If a group name is set, the bot ignores any other group.

## Mention And Trigger Behavior

The bot supports two ways to call it:

- a real WhatsApp mention
- a plain-text alias from `BOT_TRIGGER_ALIASES`

Example alias config:

```env
BOT_TRIGGER_ALIASES=Meal Tracker BOT
```

### Why Mention Matching Is More Complex Now

With Baileys, the logged-in bot may have more than one identity form at runtime.

Examples seen during development:

- bot identity log: `628970258271:2@s.whatsapp.net`
- mention payload in group: `15565800402972@lid`

Because of that, the bot now matches mentions against a set of known identities instead of a single JID.

Current matching strategy:

- collect all bot IDs available from Baileys user state
- include `id`
- include `lid`
- include `phoneNumber`
- derive comparable forms like `@s.whatsapp.net` and `@lid`
- compare normalized keys against mentioned IDs

This logic lives around:

- `extractBotJids()`
- `hasStructuredMention()`
- `getComparableIdKeys()`

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
- saves the resulting macro estimate to Supabase `meal_logs`
- replies with structured macro output plus a save confirmation or save warning

If no food text is provided, the bot replies with a usage hint.

### `!today`

Example:

```text
@Meal Tracker BOT !today
```

Behavior:

- reads today's non-deleted meal logs for the sender
- totals calories, protein, carbs, and fiber
- counts the sender's logs across all groups, not only the current group
- uses the Asia/Jakarta day boundary for "today"

### `!history`

Example:

```text
@Meal Tracker BOT !history
```

Behavior:

- reads the sender's recent non-deleted meal logs across all groups
- replies with the latest 5 logs
- includes timestamp, food name, calories, protein, carbs, and fiber

### `!undo`

Example:

```text
@Meal Tracker BOT !undo
```

Behavior:

- finds the sender's most recent non-deleted meal log across all groups
- soft-deletes it by setting `deleted_at`
- does not permanently delete the row from Supabase

### `!summary`

Example:

```text
@Meal Tracker BOT !summary
```

Behavior:

- loads the current WhatsApp group participants
- reads today's non-deleted meal logs across all groups
- shows totals split by person for current-group participants only
- does not show unrelated people from other groups
- uses the Asia/Jakarta day boundary for "today"

### `!target`

Examples:

```text
@Meal Tracker BOT !target
@Meal Tracker BOT !target protein 120 calories 2000
@Meal Tracker BOT !target clear protein
@Meal Tracker BOT !target clear
```

Behavior:

- stores persistent personal daily nutrition targets in Supabase `nutrition_targets`
- targets are per sender, not per group
- an empty `!target` command shows the sender's active target
- key-value pairs update only the provided fields
- `clear` soft-clears the whole target row by setting `deleted_at`
- `clear protein` or other listed fields set those target fields to `null`
- accepted fields include calories, protein, carbs, and fiber aliases
- values must be positive whole numbers

## Photo Behavior

Photo analysis is mention-driven and does not require `!log`.

Valid examples:

```text
@Meal Tracker BOT
```

Sent as the caption of a photo.

```text
@Meal Tracker BOT !log
```

Also valid as a photo caption.

Behavior:

- once the bot is called in a media message
- it downloads the image using Baileys `downloadMediaMessage(...)`
- converts the media buffer to base64
- sends it into Gemini
- saves the resulting macro estimate to Supabase `meal_logs`
- replies with estimated food name, calories, protein, carbs, and fiber

Important nuance:

- for media-only mention captions, the command text may normalize to an empty string
- the bot treats that as "mentioned image, analyze it"
- it does not treat that as "not mentioned"

## AI Service Behavior

`src/services/ai.ts` is a real Gemini integration.

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

## Meal Log Persistence

Successful text and photo analyses are now persisted to Supabase through `src/services/mealLog.ts`.

Storage configuration:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service writes to the `meal_logs` table through Supabase REST. It uses the service role key because this bot is a trusted server-side worker, not browser/client code.

App-level meal logs use camelCase fields in `MealLog`, then map to snake_case database columns in `MealLogRow`.

Important saved fields:

- `id`
- `created_at`
- `group_jid`
- `group_name`
- `sender_jid`
- `sender_name`
- `message_id`
- `source_type`
- `input_text`
- `food_name`
- `calories`
- `protein_g`
- `carbs_g`
- `fiber_g`
- `ai_model`
- `raw_estimate_json`
- `deleted_at`

The app currently generates UUIDs before insert. This keeps inserts working even if the Supabase table does not have a database-side default for `id`.

If Supabase saving fails after Gemini succeeds, the bot still replies with the nutrition estimate but includes a warning instead of a saved confirmation.

## Daily Target Persistence

Personal daily targets are persisted to Supabase through `src/services/nutritionTarget.ts`.

Storage configuration reuses:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Schema reference:

- `docs/nutrition_targets_schema_reference.sql`

Important saved fields:

- `id`
- `created_at`
- `updated_at`
- `sender_jid`
- `sender_name`
- `calories`
- `protein_g`
- `carbs_g`
- `fiber_g`
- `deleted_at`

Targets persist until changed or cleared. Daily progress resets naturally because `!today` only totals meal logs within the current Asia/Jakarta day.

When a target exists, `!today` renders configured fields as `current / target`. Unset fields are still shown as current totals without a target comparison.

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

## Baileys-Specific Runtime Notes

Current socket behavior:

- uses `printQRInTerminal: false`
- prints QR manually with `qrcode-terminal`
- uses `Browsers.macOS('Meal Tracker BOT')`
- reconnects automatically after most disconnects
- waits 5 seconds before reconnecting
- avoids reconnect storms with a reconnect guard

Media download behavior:

- uses `downloadMediaMessage(...)`
- passes `socket.updateMediaMessage` for reupload handling
- uses a silent `pino` logger

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
✅ Saved to your meal log.
```

If Gemini succeeds but Supabase saving fails, the final line is:

```text
⚠️ Nutrition estimated, but Supabase save failed.
```

## Current Environment Variables

Known variables used now:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BOT_TRIGGER_ALIASES`
- `TARGET_GROUP_NAME`
- `BAILEYS_AUTH_DIR`
- `SESSION_CREDS_JSON`

Example:

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
SUPABASE_URL=your_supabase_project_url_here
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here
BOT_TRIGGER_ALIASES=Meal Tracker BOT
TARGET_GROUP_NAME=
BAILEYS_AUTH_DIR=.baileys_auth
SESSION_CREDS_JSON=
```

## Current Dev Commands

From the project root:

```bash
rtk npm run dev
rtk npm run build
```

Current `dev` script behavior:

- runs `npm run build`
- then runs `node dist/index.js`

This is intentionally simple because the prior dev launch path caused runtime issues with this dependency stack in the local environment.

## Repo Hygiene

The repo now includes:

- `.gitignore`
- `.env.example`

Ignored local-only artifacts:

- `.env`
- `.baileys_auth*/`
- `.wwebjs_auth/`
- `.wwebjs_cache/`
- `dist/`
- `node_modules/`
- `docs/PROJECT_CONTEXT_AND_CHAT_HISTORY.md`

## Important Current Limitations

Current limitations still in place:

- meal logs, personal daily totals, history, undo, and group-participant summaries are implemented
- daily target tracking is implemented, but weekly summaries are not
- no dashboard yet
- no direct-message support
- nutrition output is still estimation, not verified food-label data
- Gemini quota and billing can still block analysis if the project has no usable quota
- Render session injection currently restores `creds.json`, but a full persistent auth store may still be needed if Baileys key files become important across restarts

## Suggested Use For Future Agents

Before changing behavior, a future agent should check:

1. Whether the user wants the `TARGET_GROUP_NAME` lock to stay enabled
2. Whether plain-text alias triggers should remain alongside true mentions
3. Whether DM support should be added
4. Whether image-only mention behavior should stay permissive
5. Whether full auth persistence beyond `creds.json` should be implemented
6. Whether the next milestone is weekly summaries, target refinements, or dashboard work
