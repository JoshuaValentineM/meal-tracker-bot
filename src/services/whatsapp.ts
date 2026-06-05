import fs from 'fs';
import path from 'path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { AIService, AIServiceError, MacroEstimate } from './ai.js';
import { MealLogService } from './mealLog.js';
import { NutritionTargetService } from './nutritionTarget.js';
import type { MealLog, MealSourceType } from '../types/meal-log.js';
import type { NutritionTarget, NutritionTargetField, NutritionTargetValues } from '../types/nutrition-target.js';

type ContextInfoCarrier = {
  text?: string | null;
  caption?: string | null;
  contextInfo?: proto.IContextInfo | null;
};

type MacroTotals = {
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
};

type ParticipantIdentity = {
  jid: string;
  displayName?: string;
  keys: Set<string>;
};

type TargetCommand =
  | { action: 'show' }
  | { action: 'clearAll' }
  | { action: 'clearFields'; fields: NutritionTargetField[] }
  | { action: 'update'; values: NutritionTargetValues };

export class WhatsAppService {
  private socket: WASocket | null;
  private readonly aiService: AIService;
  private readonly mealLogService: MealLogService;
  private readonly nutritionTargetService: NutritionTargetService;
  private readonly logger;
  private readonly triggerAliases: string[];
  private readonly targetGroupName: string | null;
  private readonly authDir: string;
  private botJids: string[];
  private reconnectInProgress: boolean;
  private connectionState: string;
  private lastOpenAt: string | null;
  private lastCloseAt: string | null;
  private lastMessageAt: string | null;

  constructor() {
    this.socket = null;
    this.aiService = new AIService();
    this.mealLogService = new MealLogService();
    this.nutritionTargetService = new NutritionTargetService();
    this.logger = pino({ level: 'silent' });
    this.triggerAliases = this.loadTriggerAliases();
    this.targetGroupName = process.env.TARGET_GROUP_NAME?.trim() || null;
    this.authDir = process.env.BAILEYS_AUTH_DIR?.trim() || path.join(process.cwd(), '.baileys_auth');
    this.botJids = [];
    this.reconnectInProgress = false;
    this.connectionState = 'initializing';
    this.lastOpenAt = null;
    this.lastCloseAt = null;
    this.lastMessageAt = null;
  }

  public async initialize(): Promise<void> {
    await this.startSocket();
  }

  public getStatus(): Record<string, unknown> {
    return {
      service: 'meal-tracker-bot',
      whatsappConnection: this.connectionState,
      connected: this.connectionState === 'open',
      botJids: this.botJids,
      targetGroupName: this.targetGroupName,
      triggerAliases: this.triggerAliases,
      mealLogStorageConfigured: this.mealLogService.isConfigured(),
      targetStorageConfigured: this.nutritionTargetService.isConfigured(),
      lastOpenAt: this.lastOpenAt,
      lastCloseAt: this.lastCloseAt,
      lastMessageAt: this.lastMessageAt,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  private async startSocket(): Promise<void> {
    this.ensureAuthDirectory();
    this.injectSessionCredsIfNeeded();

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.macOS('Meal Tracker BOT'),
      logger: this.logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.socket = socket;
    this.botJids = this.extractBotJids(socket.user);

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update);
    });
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const message of messages) {
        try {
          await this.handleIncomingMessage(message);
        } catch (error) {
          console.error('Error handling incoming message:', error);
        }
      }
    });
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n==================================================================');
      console.log("▼ SCAN THIS QR CODE USING YOUR BOT'S WHATSAPP APPLICATION (LINK DEVICE):");
      console.log('==================================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'connecting') {
      this.connectionState = 'connecting';
      console.log('Connecting to WhatsApp via Baileys...');
      return;
    }

    if (connection === 'open') {
      this.connectionState = 'open';
      this.lastOpenAt = new Date().toISOString();
      this.reconnectInProgress = false;
      this.botJids = this.extractBotJids(this.socket?.user);
      console.log('\n🚀 Success! Meal Tracker Bot is officially online and listening!');
      console.log('Running on Baileys WebSocket transport.');
      console.log(
        this.targetGroupName
          ? `Listening only in group: "${this.targetGroupName}", and only when the bot is called.`
          : 'Listening in any group where this bot is mentioned with @ or called by its trigger name.'
      );
      console.log(`Bot WhatsApp IDs: ${this.botJids.length > 0 ? this.botJids.join(', ') : 'unknown'}`);
      console.log(`Trigger aliases: ${this.triggerAliases.join(', ')}`);
      return;
    }

    if (connection === 'close') {
      this.connectionState = 'close';
      this.lastCloseAt = new Date().toISOString();
      const statusCode = this.getDisconnectStatusCode(lastDisconnect?.error);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.error('WhatsApp connection closed:', lastDisconnect?.error);

      if (shouldReconnect) {
        if (this.reconnectInProgress) {
          return;
        }

        this.reconnectInProgress = true;
        console.log('Reconnecting to WhatsApp...');
        await this.delay(5000);
        await this.startSocket();
      } else {
        console.error('WhatsApp session logged out. Delete .baileys_auth and link again.');
      }
    }
  }

  private async handleIncomingMessage(message: WAMessage): Promise<void> {
    this.lastMessageAt = new Date().toISOString();
    const remoteJid = message.key.remoteJid;
    const normalizedRemoteJid = this.normalizeJid(remoteJid);
    const isGroup = Boolean(normalizedRemoteJid?.endsWith('@g.us'));
    const fromMe = Boolean(message.key.fromMe);
    const body = this.extractMessageText(message);
    const hasMedia = this.hasMedia(message);
    const mentionedIds = this.getMentionedIds(message);

    console.log(
      `[message] fromMe=${fromMe} group=${isGroup} chat="${normalizedRemoteJid}" body="${body}" hasMedia=${hasMedia} mentions=${JSON.stringify(mentionedIds)}`
    );

    if (!remoteJid || !isGroup || fromMe) {
      return;
    }

    if (this.targetGroupName) {
      const metadata = await this.socket?.groupMetadata(remoteJid);
      const subject = metadata?.subject?.trim() || '';
      if (subject !== this.targetGroupName) {
        console.log(`Ignoring group "${subject}" because it does not match TARGET_GROUP_NAME.`);
        return;
      }
    }

    const commandText = this.extractCommandText(message);
    if (commandText === null) {
      console.log(`Ignoring message in "${normalizedRemoteJid}" because the bot was not mentioned.`);
      return;
    }

    const command = commandText.split(/\s+/)[0]?.toLowerCase() || '';

    if (command === '!today') {
      await this.handleTodayCommand(message);
      return;
    }

    if (command === '!history') {
      await this.handleHistoryCommand(message);
      return;
    }

    if (command === '!undo') {
      await this.handleUndoCommand(message);
      return;
    }

    if (command === '!summary') {
      await this.handleSummaryCommand(message);
      return;
    }

    if (command === '!target') {
      await this.handleTargetCommand(message, commandText.replace(/!target/i, '').trim());
      return;
    }

    if (hasMedia && command !== '!help') {
      await this.handleMentionedMediaMessage(message);
      return;
    }

    if (!commandText || command === '!help') {
      await this.reply(message, this.getHelpMessage());
      return;
    }

    if (command === '!log') {
      const foodText = commandText.replace(/!log/i, '').trim();
      if (!foodText) {
        await this.reply(
          message,
          '❌ Format belum lengkap. Contoh: `@bot !log 200g dada ayam panggang` atau kirim foto dengan caption `@bot`.'
        );
        return;
      }

      await this.handleMentionedTextLog(message, foodText);
      return;
    }

    await this.reply(message, '❓ Perintah belum dikenali. Kirim `@bot !help` untuk melihat cara pakai.');
  }

  private async handleMentionedTextLog(message: WAMessage, foodText: string): Promise<void> {
    if (!this.aiService.isConfigured()) {
      await this.reply(message, '❌ GEMINI_API_KEY belum disetel. Tambahkan dulu di file .env agar analisis bisa jalan.');
      return;
    }

    const processingMessage = await this.reply(message, `📝 Processing text entry: "${foodText}"...`);

    try {
      const macros = await this.aiService.analyzeTextPayload(foodText);
      const saved = await this.saveMealLogForMessage(message, 'text', foodText, macros);
      await this.deleteMessage(processingMessage);
      await this.reply(message, this.formatMacroResponse(macros, saved));
    } catch (error) {
      console.error('Failed to analyze text payload:', error);
      await this.reply(
        message,
        this.getFriendlyErrorMessage(error, '❌ Gagal menganalisis log teks. Coba tulis makanan dan porsinya lebih jelas ya.')
      );
    }
  }

  private async handleMentionedMediaMessage(message: WAMessage): Promise<void> {
    if (!this.aiService.isConfigured()) {
      await this.reply(message, '❌ GEMINI_API_KEY belum disetel. Tambahkan dulu di file .env agar analisis foto bisa jalan.');
      return;
    }

    const processingMessage = await this.reply(message, '📸 Food photo detected! Analyzing nutrients, hold tight...');

    try {
      if (!this.socket) {
        throw new Error('WhatsApp socket is not ready.');
      }

      const mediaBuffer = await downloadMediaMessage(message, 'buffer', {}, {
        reuploadRequest: this.socket.updateMediaMessage,
        logger: this.logger,
      });
      const mimeType = this.extractMimeType(message);

      if (!mediaBuffer || !mimeType) {
        throw new Error('Media download returned no data.');
      }

      const macros = await this.aiService.analyzeImagePayload(mediaBuffer.toString('base64'), mimeType);
      const saved = await this.saveMealLogForMessage(message, 'image', this.extractMessageText(message).trim(), macros);
      await this.deleteMessage(processingMessage);
      await this.reply(message, this.formatMacroResponse(macros, saved));
    } catch (error) {
      console.error('Failed to analyze image payload:', error);
      await this.reply(
        message,
        this.getFriendlyErrorMessage(error, '❌ Ups, fotonya belum berhasil diproses. Coba kirim ulang dengan gambar yang lebih jelas.')
      );
    }
  }

  private async handleTodayCommand(message: WAMessage): Promise<void> {
    const senderJid = this.getSenderJid(message);
    if (!senderJid) {
      await this.reply(message, '❌ Tidak bisa membaca identitas pengirim untuk menghitung total hari ini.');
      return;
    }

    try {
      const { startIso, endIso } = this.getTodayRange();
      const logs = await this.mealLogService.getMealLogsForDateRange(startIso, endIso);
      const senderLogs = this.filterLogsByPerson(logs, senderJid);
      const totals = this.calculateTotals(senderLogs);
      const target = await this.getTargetForToday(senderJid);

      await this.reply(message, this.formatTodayResponse(senderLogs, totals, target));
    } catch (error) {
      console.error('Failed to handle !today command:', error);
      await this.reply(message, this.getMealLogCommandErrorMessage());
    }
  }

  private async handleTargetCommand(message: WAMessage, targetText: string): Promise<void> {
    const senderJid = this.getSenderJid(message);
    if (!senderJid) {
      await this.reply(message, '❌ Tidak bisa membaca identitas pengirim untuk mengatur target.');
      return;
    }

    try {
      const parsed = this.parseTargetCommand(targetText);
      if (!parsed) {
        await this.reply(message, this.getTargetUsageMessage());
        return;
      }

      if (parsed.action === 'show') {
        const target = await this.nutritionTargetService.getTarget(senderJid);
        await this.reply(message, this.formatTargetResponse(target));
        return;
      }

      if (parsed.action === 'clearAll') {
        await this.nutritionTargetService.clearTarget(senderJid, new Date().toISOString());
        await this.reply(message, '🧹 *Daily target cleared*\n━━━━━━━━━━━━━━━━━━\nSemua target harian kamu sudah dihapus.');
        return;
      }

      if (parsed.action === 'clearFields') {
        const clearValues = Object.fromEntries(parsed.fields.map((field) => [field, null])) as NutritionTargetValues;
        const target = await this.nutritionTargetService.clearTargetFields(senderJid, clearValues);
        await this.reply(message, this.formatTargetUpdateResponse(target, '✅ Daily target updated'));
        return;
      }

      const target = await this.nutritionTargetService.upsertTarget(
        senderJid,
        message.pushName?.trim() || undefined,
        parsed.values
      );
      await this.reply(message, this.formatTargetUpdateResponse(target, '✅ Daily target updated'));
    } catch (error) {
      console.error('Failed to handle !target command:', error);
      await this.reply(message, this.getTargetCommandErrorMessage());
    }
  }

  private async handleHistoryCommand(message: WAMessage): Promise<void> {
    const senderJid = this.getSenderJid(message);
    if (!senderJid) {
      await this.reply(message, '❌ Tidak bisa membaca identitas pengirim untuk mengambil history.');
      return;
    }

    try {
      const logs = await this.mealLogService.getRecentMealLogs(100);
      const senderLogs = this.filterLogsByPerson(logs, senderJid).slice(0, 5);

      await this.reply(message, this.formatHistoryResponse(senderLogs));
    } catch (error) {
      console.error('Failed to handle !history command:', error);
      await this.reply(message, this.getMealLogCommandErrorMessage());
    }
  }

  private async handleUndoCommand(message: WAMessage): Promise<void> {
    const senderJid = this.getSenderJid(message);
    if (!senderJid) {
      await this.reply(message, '❌ Tidak bisa membaca identitas pengirim untuk undo log terakhir.');
      return;
    }

    try {
      const logs = await this.mealLogService.getRecentMealLogs(100);
      const latestLog = this.filterLogsByPerson(logs, senderJid)[0];

      if (!latestLog?.id) {
        await this.reply(message, '↩️ Belum ada meal log yang bisa di-undo.');
        return;
      }

      await this.mealLogService.softDeleteMealLog(latestLog.id, new Date().toISOString());
      await this.reply(message, this.formatUndoResponse(latestLog));
    } catch (error) {
      console.error('Failed to handle !undo command:', error);
      await this.reply(message, this.getMealLogCommandErrorMessage());
    }
  }

  private async handleSummaryCommand(message: WAMessage): Promise<void> {
    const groupJid = this.normalizeJid(message.key.remoteJid);
    if (!groupJid) {
      await this.reply(message, '❌ Tidak bisa membaca grup untuk membuat summary.');
      return;
    }

    try {
      const participants = await this.getGroupParticipantIdentities(groupJid);
      const { startIso, endIso } = this.getTodayRange();
      const logs = await this.mealLogService.getMealLogsForDateRange(startIso, endIso);
      const summary = this.buildParticipantSummary(logs, participants);

      await this.reply(message, this.formatSummaryResponse(summary));
    } catch (error) {
      console.error('Failed to handle !summary command:', error);
      await this.reply(message, this.getMealLogCommandErrorMessage());
    }
  }

  private extractCommandText(message: WAMessage): string | null {
    const body = this.extractMessageText(message).trim();
    const hasMedia = this.hasMedia(message);

    if (!body && !hasMedia) {
      return null;
    }

    if (this.hasStructuredMention(message)) {
      return this.normalizeCommandText(body);
    }

    return this.extractTextTriggeredCommand(body);
  }

  private hasStructuredMention(message: WAMessage): boolean {
    if (this.botJids.length === 0) {
      return false;
    }

    const botKeys = new Set(this.botJids.flatMap((jid) => this.getComparableIdKeys(jid)));
    for (const mentionedId of this.getMentionedIds(message)) {
      for (const key of this.getComparableIdKeys(mentionedId)) {
        if (botKeys.has(key)) {
          return true;
        }
      }
    }

    return false;
  }

  private getMentionedIds(message: WAMessage): string[] {
    const content = normalizeMessageContent(message.message);
    if (!content) {
      return [];
    }

    const contentType = getContentType(content);
    if (!contentType) {
      return [];
    }

    const typedContent = content[contentType] as ContextInfoCarrier | null | undefined;
    const mentionedJids = typedContent?.contextInfo?.mentionedJid || [];

    return mentionedJids
      .map((jid) => this.normalizeJid(jid))
      .filter(Boolean) as string[];
  }

  private extractMessageText(message: WAMessage): string {
    const content = normalizeMessageContent(message.message);
    if (!content) {
      return '';
    }

    if (content.conversation) {
      return content.conversation;
    }

    const contentType = getContentType(content);
    if (!contentType) {
      return '';
    }

    const typedContent = content[contentType] as ContextInfoCarrier | null | undefined;
    return typedContent?.text || typedContent?.caption || '';
  }

  private async saveMealLogForMessage(
    message: WAMessage,
    sourceType: MealSourceType,
    inputText: string,
    macros: MacroEstimate
  ): Promise<boolean> {
    try {
      const mealLog = await this.buildMealLog(message, sourceType, inputText, macros);
      await this.mealLogService.saveMealLog(mealLog);
      return true;
    } catch (error) {
      console.error('Failed to save meal log:', error);
      return false;
    }
  }

  private async buildMealLog(
    message: WAMessage,
    sourceType: MealSourceType,
    inputText: string,
    macros: MacroEstimate
  ): Promise<MealLog> {
    const groupJid = this.normalizeJid(message.key.remoteJid);
    const senderJid = this.normalizeJid(message.key.participant || message.participant || null);

    if (!groupJid) {
      throw new Error('Cannot save meal log without group JID.');
    }

    if (!senderJid) {
      throw new Error('Cannot save meal log without sender JID.');
    }

    return {
      createdAt: new Date().toISOString(),
      groupJid,
      groupName: await this.getGroupName(groupJid),
      senderJid,
      senderName: message.pushName?.trim() || undefined,
      messageId: message.key.id || undefined,
      sourceType,
      inputText: inputText || undefined,
      foodName: macros.foodName,
      calories: macros.calories,
      protein: macros.protein,
      carbs: macros.carbs,
      fiber: macros.fiber,
      aiModel: this.aiService.getModelName(),
      rawEstimateJson: { ...macros },
    };
  }

  private async getGroupName(groupJid: string): Promise<string | undefined> {
    try {
      const metadata = await this.socket?.groupMetadata(groupJid);
      return metadata?.subject?.trim() || undefined;
    } catch (error) {
      console.warn(`Could not load group metadata for "${groupJid}" while saving meal log:`, error);
      return undefined;
    }
  }

  private async getGroupParticipantIdentities(groupJid: string): Promise<ParticipantIdentity[]> {
    const metadata = await this.socket?.groupMetadata(groupJid);
    const botKeys = new Set(this.botJids.flatMap((jid) => this.getComparableIdKeys(jid)));

    return (metadata?.participants || [])
      .map((participant) => {
        const rawParticipant = participant as {
          id?: string | null;
          jid?: string | null;
          lid?: string | null;
          phoneNumber?: string | null;
        };
        const jid = this.normalizeJid(rawParticipant.id || rawParticipant.jid || rawParticipant.lid || null);
        const phoneJid = this.normalizeJid(
          rawParticipant.phoneNumber ? `${rawParticipant.phoneNumber}@s.whatsapp.net` : null
        );
        const keys = new Set([
          ...this.getComparableIdKeys(jid),
          ...this.getComparableIdKeys(phoneJid),
        ]);

        if (!jid || this.hasAnyMatchingKey(keys, botKeys)) {
          return null;
        }

        return { jid, keys };
      })
      .filter(Boolean) as ParticipantIdentity[];
  }

  private getSenderJid(message: WAMessage): string | null {
    return this.normalizeJid(message.key.participant || message.participant || null);
  }

  private filterLogsByPerson(logs: MealLog[], personJid: string): MealLog[] {
    const personKeys = new Set(this.getComparableIdKeys(personJid));
    return logs.filter((log) => this.hasAnyMatchingKey(new Set(this.getComparableIdKeys(log.senderJid)), personKeys));
  }

  private buildParticipantSummary(
    logs: MealLog[],
    participants: ParticipantIdentity[]
  ): Array<{ displayName: string; totals: MacroTotals; count: number }> {
    const summaries = new Map<string, { displayName: string; totals: MacroTotals; count: number }>();

    for (const log of logs) {
      const logKeys = new Set(this.getComparableIdKeys(log.senderJid));
      const participant = participants.find((candidate) => this.hasAnyMatchingKey(logKeys, candidate.keys));

      if (!participant) {
        continue;
      }

      const existing = summaries.get(participant.jid) || {
        displayName: log.senderName?.trim() || this.formatShortJid(participant.jid),
        totals: this.emptyTotals(),
        count: 0,
      };

      existing.displayName = log.senderName?.trim() || existing.displayName;
      existing.totals = this.addTotals(existing.totals, log);
      existing.count += 1;
      summaries.set(participant.jid, existing);
    }

    return [...summaries.values()].sort((a, b) => b.totals.calories - a.totals.calories);
  }

  private calculateTotals(logs: MealLog[]): MacroTotals {
    return logs.reduce((totals, log) => this.addTotals(totals, log), this.emptyTotals());
  }

  private addTotals(totals: MacroTotals, log: MealLog): MacroTotals {
    return {
      calories: totals.calories + log.calories,
      protein: totals.protein + log.protein,
      carbs: totals.carbs + log.carbs,
      fiber: totals.fiber + log.fiber,
    };
  }

  private emptyTotals(): MacroTotals {
    return {
      calories: 0,
      protein: 0,
      carbs: 0,
      fiber: 0,
    };
  }

  private hasAnyMatchingKey(left: Set<string>, right: Set<string>): boolean {
    for (const key of left) {
      if (right.has(key)) {
        return true;
      }
    }

    return false;
  }

  private getTodayRange(): { startIso: string; endIso: string } {
    const jakartaOffsetMs = 7 * 60 * 60 * 1000;
    const localNow = new Date(Date.now() + jakartaOffsetMs);
    const startUtcMs =
      Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - jakartaOffsetMs;
    const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

    return {
      startIso: new Date(startUtcMs).toISOString(),
      endIso: new Date(endUtcMs).toISOString(),
    };
  }

  private formatTodayResponse(logs: MealLog[], totals: MacroTotals, target: NutritionTarget | null): string {
    const targetHint = this.hasTargetValues(target)
      ? ''
      : '\n_Set target dengan: `@bot !target protein 120 calories 2000`_';

    if (logs.length === 0 && !this.hasTargetValues(target)) {
      return (
        '📅 *Today so far*\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Belum ada meal log hari ini.\n' +
        'Kirim `@bot !log nasi ayam` untuk mulai tracking.\n' +
        '_Set target dengan: `@bot !target protein 120 calories 2000`_'
      );
    }

    return (
      '📅 *Today so far*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      `🍽️ *Logs:* ${logs.length}\n` +
      this.formatTodayMacroLines(totals, target).join('\n') +
      '\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '_Dihitung dari semua grup tempat kamu log hari ini._' +
      targetHint
    );
  }

  private formatTodayMacroLines(totals: MacroTotals, target: NutritionTarget | null): string[] {
    return [
      this.formatTodayMacroLine('🔥', 'Kalori', totals.calories, target?.calories, 'kcal'),
      this.formatTodayMacroLine('💪', 'Protein', totals.protein, target?.protein, 'g'),
      this.formatTodayMacroLine('🍞', 'Karbohidrat', totals.carbs, target?.carbs, 'g'),
      this.formatTodayMacroLine('🥗', 'Serat', totals.fiber, target?.fiber, 'g'),
    ];
  }

  private formatTodayMacroLine(
    icon: string,
    label: string,
    current: number,
    target: number | null | undefined,
    unit: string
  ): string {
    if (target === null || target === undefined) {
      return `${icon} *${label}:* ${current}${unit === 'kcal' ? ` ${unit}` : unit}`;
    }

    return `${icon} *${label}:* ${current} / ${target}${unit === 'kcal' ? ` ${unit}` : unit}`;
  }

  private formatHistoryResponse(logs: MealLog[]): string {
    if (logs.length === 0) {
      return '📜 *Recent meal logs*\n━━━━━━━━━━━━━━━━━━\nBelum ada meal log yang tersimpan.';
    }

    const rows = logs.map((log, index) => {
      return (
        `${index + 1}. *${log.foodName}*\n` +
        `   ${this.formatMealLogTimestamp(log.createdAt)} · ${log.calories} kcal · P ${log.protein}g · C ${log.carbs}g · F ${log.fiber}g`
      );
    });

    return '📜 *Recent meal logs*\n━━━━━━━━━━━━━━━━━━\n' + rows.join('\n\n');
  }

  private formatUndoResponse(log: MealLog): string {
    return (
      '↩️ *Last meal log undone*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      `📝 *Menu:* ${log.foodName}\n` +
      `🔥 *Kalori:* ${log.calories} kcal\n` +
      `💪 *Protein:* ${log.protein}g\n` +
      `🍞 *Karbohidrat:* ${log.carbs}g\n` +
      `🥗 *Serat:* ${log.fiber}g`
    );
  }

  private formatSummaryResponse(
    summaries: Array<{ displayName: string; totals: MacroTotals; count: number }>
  ): string {
    if (summaries.length === 0) {
      return '📊 *Today summary*\n━━━━━━━━━━━━━━━━━━\nBelum ada meal log hari ini untuk anggota grup ini.';
    }

    const rows = summaries.map((summary) => {
      return (
        `*${summary.displayName}*\n` +
        `🍽️ Logs: ${summary.count}\n` +
        `🔥 ${summary.totals.calories} kcal\n` +
        `💪 Protein ${summary.totals.protein}g\n` +
        `🍞 Karbohidrat ${summary.totals.carbs}g\n` +
        `🥗 Serat ${summary.totals.fiber}g`
      );
    });

    return (
      '📊 *Today summary*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      rows.join('\n\n') +
      '\n━━━━━━━━━━━━━━━━━━\n' +
      '_Hanya anggota grup ini, tapi log dihitung dari semua grup._'
    );
  }

  private formatMealLogTimestamp(value: string): string {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  private formatShortJid(jid: string): string {
    return jid.split('@')[0].split(':')[0];
  }

  private getMealLogCommandErrorMessage(): string {
    if (!this.mealLogService.isConfigured()) {
      return '❌ Supabase belum dikonfigurasi. Tambahkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`.';
    }

    return '❌ Gagal membaca meal log dari Supabase. Coba lagi sebentar ya.';
  }

  private async getTargetForToday(senderJid: string): Promise<NutritionTarget | null> {
    try {
      return await this.nutritionTargetService.getTarget(senderJid);
    } catch (error) {
      console.error('Failed to load nutrition target for !today:', error);
      return null;
    }
  }

  private parseTargetCommand(text: string): TargetCommand | null {
    const tokens = text.split(/\s+/).map((token) => token.trim()).filter(Boolean);

    if (tokens.length === 0) {
      return { action: 'show' };
    }

    if (tokens[0]?.toLowerCase() === 'clear') {
      if (tokens.length === 1) {
        return { action: 'clearAll' };
      }

      const fields = tokens.slice(1).map((token) => this.normalizeTargetField(token));
      if (fields.some((field) => field === null)) {
        return null;
      }

      return { action: 'clearFields', fields: [...new Set(fields as NutritionTargetField[])] };
    }

    if (tokens.length % 2 !== 0) {
      return null;
    }

    const values: NutritionTargetValues = {};
    const seenFields = new Set<NutritionTargetField>();

    for (let index = 0; index < tokens.length; index += 2) {
      const field = this.normalizeTargetField(tokens[index]);
      const value = this.parsePositiveInteger(tokens[index + 1]);

      if (!field || value === null || seenFields.has(field)) {
        return null;
      }

      values[field] = value;
      seenFields.add(field);
    }

    return seenFields.size > 0 ? { action: 'update', values } : null;
  }

  private normalizeTargetField(value: string | undefined): NutritionTargetField | null {
    const normalized = value?.toLowerCase();

    if (!normalized) {
      return null;
    }

    if (['calories', 'calorie', 'kalori', 'cal'].includes(normalized)) {
      return 'calories';
    }

    if (['protein', 'proteins', 'p'].includes(normalized)) {
      return 'protein';
    }

    if (['carbs', 'carb', 'karbo', 'karbohidrat', 'c'].includes(normalized)) {
      return 'carbs';
    }

    if (['fiber', 'fibre', 'serat', 'f'].includes(normalized)) {
      return 'fiber';
    }

    return null;
  }

  private parsePositiveInteger(value: string | undefined): number | null {
    if (!value || !/^[1-9]\d*$/.test(value)) {
      return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  private formatTargetResponse(target: NutritionTarget | null): string {
    if (!this.hasTargetValues(target)) {
      return (
        '🎯 *Daily target*\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Belum ada target harian.\n' +
        'Set dengan: `@bot !target protein 120 calories 2000`'
      );
    }

    return '🎯 *Daily target*\n━━━━━━━━━━━━━━━━━━\n' + this.formatTargetLines(target).join('\n');
  }

  private formatTargetUpdateResponse(target: NutritionTarget | null, title: string): string {
    if (!this.hasTargetValues(target)) {
      return (
        `${title}\n` +
        '━━━━━━━━━━━━━━━━━━\n' +
        'Belum ada target aktif.\n' +
        'Set dengan: `@bot !target protein 120 calories 2000`'
      );
    }

    return `${title}\n━━━━━━━━━━━━━━━━━━\n` + this.formatTargetLines(target).join('\n');
  }

  private formatTargetLines(target: NutritionTarget): string[] {
    const lines: string[] = [];

    if (target.calories !== null && target.calories !== undefined) {
      lines.push(`🔥 *Kalori:* ${target.calories} kcal`);
    }

    if (target.protein !== null && target.protein !== undefined) {
      lines.push(`💪 *Protein:* ${target.protein}g`);
    }

    if (target.carbs !== null && target.carbs !== undefined) {
      lines.push(`🍞 *Karbohidrat:* ${target.carbs}g`);
    }

    if (target.fiber !== null && target.fiber !== undefined) {
      lines.push(`🥗 *Serat:* ${target.fiber}g`);
    }

    return lines;
  }

  private hasTargetValues(target: NutritionTarget | null | undefined): target is NutritionTarget {
    return Boolean(
      target &&
        [target.calories, target.protein, target.carbs, target.fiber].some((value) => value !== null && value !== undefined)
    );
  }

  private getTargetUsageMessage(): string {
    return (
      '❌ *Format target belum valid*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      'Contoh:\n' +
      '• `@bot !target`\n' +
      '• `@bot !target protein 120 calories 2000`\n' +
      '• `@bot !target carbs 220 fiber 25`\n' +
      '• `@bot !target clear protein`\n' +
      '• `@bot !target clear`\n\n' +
      'Nilai harus angka bulat positif.'
    );
  }

  private getTargetCommandErrorMessage(): string {
    if (!this.nutritionTargetService.isConfigured()) {
      return '❌ Supabase belum dikonfigurasi. Tambahkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`.';
    }

    return '❌ Gagal membaca atau menyimpan target dari Supabase. Pastikan tabel `nutrition_targets` sudah dibuat.';
  }

  private hasMedia(message: WAMessage): boolean {
    return Boolean(this.extractMimeType(message));
  }

  private extractMimeType(message: WAMessage): string | null {
    const content = normalizeMessageContent(message.message);
    if (!content) {
      return null;
    }

    const contentType = getContentType(content);
    if (!contentType) {
      return null;
    }

    const typedContent = content[contentType] as { mimetype?: string | null } | null | undefined;
    return typedContent?.mimetype || null;
  }

  private extractTextTriggeredCommand(text: string): string | null {
    if (!text) {
      return null;
    }

    for (const alias of this.triggerAliases) {
      const escapedAlias = this.escapeRegExp(alias);
      const match = text.match(new RegExp(`^\\s*@?${escapedAlias}(?:\\s+|$)`, 'i'));
      if (match) {
        return text.slice(match[0].length).trim();
      }
    }

    return null;
  }

  private normalizeCommandText(text: string): string {
    for (const alias of this.triggerAliases) {
      const escapedAlias = this.escapeRegExp(alias);
      text = text.replace(new RegExp(`@?${escapedAlias}`, 'ig'), ' ');
    }

    return text.replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private loadTriggerAliases(): string[] {
    const configuredAliases = (process.env.BOT_TRIGGER_ALIASES || '')
      .split(',')
      .map((alias) => alias.trim())
      .filter(Boolean);

    const aliases = configuredAliases.length > 0 ? configuredAliases : ['Meal Tracker BOT'];
    return [...new Set(aliases)];
  }

  private normalizeJid(jid: string | null | undefined): string | null {
    if (!jid) {
      return null;
    }

    return jid.toLowerCase();
  }

  private extractBotJids(user: { id?: string; lid?: string; phoneNumber?: string } | null | undefined): string[] {
    if (!user) {
      return [];
    }

    const candidates = [
      this.normalizeJid(user.id),
      this.normalizeJid(user.lid),
      this.normalizeJid(user.phoneNumber),
      this.normalizeJid(user.phoneNumber ? `${user.phoneNumber}@s.whatsapp.net` : null),
      this.normalizeJid(user.phoneNumber ? `${user.phoneNumber}@lid` : null),
    ];

    return [...new Set(candidates.filter(Boolean) as string[])];
  }

  private getComparableIdKeys(id: string | null): string[] {
    if (!id) {
      return [];
    }

    const normalized = id.toLowerCase();
    const userPart = normalized.split('@')[0].split(':')[0];
    const digitPart = userPart.replace(/\D/g, '');

    return [...new Set([normalized, userPart, digitPart].filter(Boolean))];
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private getHelpMessage(): string {
    return (
      '🤖 *Meal Tracker Bot Help*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      'Mention bot dulu dengan `@bot`, lalu pakai salah satu command ini:\n\n' +
      '• `@bot !help`\n' +
      'Menampilkan panduan dan daftar command.\n\n' +
      '• `@bot !log nasi ayam`\n' +
      'Analisis log makanan dari teks.\n\n' +
      '• `@bot !today`\n' +
      'Lihat total nutrisi kamu hari ini dari semua grup.\n\n' +
      '• `@bot !history`\n' +
      'Lihat 5 meal log terakhirmu.\n\n' +
      '• `@bot !undo`\n' +
      'Undo meal log terakhirmu.\n\n' +
      '• `@bot !summary`\n' +
      'Lihat summary hari ini per orang untuk anggota grup ini.\n\n' +
      '• `@bot !target protein 120 calories 2000`\n' +
      'Set, lihat, atau clear target harian personal.\n\n' +
      '• Mention bot + kirim foto\n' +
      'Analisis makanan dari foto. `!log` di caption bersifat opsional.\n\n' +
      'Contoh:\n' +
      '• `@bot !log 150g dada ayam panggang`\n' +
      '• Kirim foto dengan caption `@bot`\n' +
      '• Kirim foto dengan caption `@bot !log`'
    );
  }

  private formatMacroResponse(data: MacroEstimate, saved?: boolean): string {
    const saveStatus =
      saved === undefined
        ? ''
        : saved
          ? '\n✅ *Saved to your meal log.*'
          : '\n⚠️ *Nutrition estimated, but Supabase save failed.*';

    return (
      '🍽️ *Nutrient Log Verified!*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      `📝 *Menu:* ${data.foodName}\n\n` +
      `🔥 *Kalori:* ${data.calories} kcal\n` +
      `💪 *Protein:* ${data.protein}g\n` +
      `🍞 *Karbohidrat:* ${data.carbs}g\n` +
      `🥗 *Serat:* ${data.fiber}g\n` +
      '━━━━━━━━━━━━━━━━━━' +
      saveStatus
    );
  }

  private getFriendlyErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof AIServiceError) {
      return error.userMessage;
    }

    return fallback;
  }

  private async reply(message: WAMessage, text: string): Promise<WAMessage | undefined> {
    if (!this.socket || !message.key.remoteJid) {
      return undefined;
    }

    return this.socket.sendMessage(message.key.remoteJid, { text }, { quoted: message });
  }

  private async deleteMessage(message: WAMessage | undefined): Promise<void> {
    if (!this.socket || !message?.key.remoteJid || !message.key.id) {
      return;
    }

    await this.socket.sendMessage(message.key.remoteJid, { delete: message.key });
  }

  private ensureAuthDirectory(): void {
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  private injectSessionCredsIfNeeded(): void {
    const credsPath = path.join(this.authDir, 'creds.json');
    const credsJson = process.env.SESSION_CREDS_JSON;

    if (credsJson && !fs.existsSync(credsPath)) {
      fs.writeFileSync(credsPath, credsJson);
      console.log('🔒 Session credentials injected successfully from environment variables.');
    }
  }

  private getDisconnectStatusCode(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }

    const maybeBoom = error as {
      output?: {
        statusCode?: number;
      };
      statusCode?: number;
    };

    return maybeBoom.output?.statusCode ?? maybeBoom.statusCode;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
