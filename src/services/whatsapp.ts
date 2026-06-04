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
import type { MealLog, MealSourceType } from '../types/meal-log.js';

type ContextInfoCarrier = {
  text?: string | null;
  caption?: string | null;
  contextInfo?: proto.IContextInfo | null;
};

export class WhatsAppService {
  private socket: WASocket | null;
  private readonly aiService: AIService;
  private readonly mealLogService: MealLogService;
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
