import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import { AIService, AIServiceError, MacroEstimate } from './ai.js';

export class WhatsAppService {
  private client: any;
  private readonly aiService: AIService;
  private readonly triggerAliases: string[];
  private botWid: unknown;

  constructor() {
    this.aiService = new AIService();
    this.triggerAliases = this.loadTriggerAliases();
    this.botWid = null;
    this.client = new Client({
      // LocalAuth saves the session token inside a local directory (.wwebjs_auth)
      // This means you only need to scan the QR code once!
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process'
        ],
      }
    });
  }

  public initialize(): void {
    // Event: Triggers when a QR code needs to be scanned
    this.client.on('qr', (qr: string) => {
      console.log('\n==================================================================');
      console.log('▼ SCAN THIS QR CODE USING YOUR BOT\'S WHATSAPP APPLICTION (LINK DEVICE):');
      console.log('==================================================================\n');
      qrcode.generate(qr, { small: true });
    });

    this.client.on('authenticated', () => {
      console.log('Authenticated with WhatsApp.');
    });

    this.client.on('auth_failure', (message: string) => {
      console.error('WhatsApp authentication failed:', message);
    });

    this.client.on('loading_screen', (percent: number, message: string) => {
      console.log(`Loading WhatsApp client: ${percent}% - ${message}`);
    });

    this.client.on('change_state', (state: string) => {
      console.log(`WhatsApp state changed: ${state}`);
    });

    this.client.on('disconnected', (reason: string) => {
      console.error(`WhatsApp client disconnected: ${reason}`);
    });

    // Event: Triggers when the client successfully authenticates and loads
    this.client.on('ready', async () => {
      this.botWid = this.client?.info?.wid || null;
      console.log('\n🚀 Success! Meal Tracker Bot is officially online and listening!');
      console.log('Listening in any group where this bot is mentioned with @ or called by its trigger name.');
      console.log(`Bot WhatsApp ID: ${this.serializeWhatsAppId(this.botWid) ?? 'unknown'}`);
      console.log(`Trigger aliases: ${this.triggerAliases.join(', ')}`);

      try {
        const chats = await this.client.getChats();
        const groupNames = chats
          .filter((chat: any) => chat.isGroup)
          .map((chat: any) => chat.name);

        console.log('Detected WhatsApp groups:', groupNames);
      } catch (error) {
        console.error('Failed to load chat list:', error);
      }
    });

    this.client.on('message_create', async (msg: any) => {
      const chat = await msg.getChat();
      console.log(
        `[message_create] fromMe=${msg.fromMe} chat="${chat.name}" body="${msg.body}" hasMedia=${msg.hasMedia} mentions=${JSON.stringify(msg.mentionedIds || [])}`
      );
    });

    // Event: Listens to incoming text/media messages
    this.client.on('message', async (msg: any) => {
      try {
        await this.handleIncomingMessage(msg);
      } catch (error) {
        console.error('Error handling incoming message:', error);
      }
    });

    this.client.initialize();
  }

  private async handleIncomingMessage(msg: any): Promise<void> {
    const chat = await msg.getChat();
    console.log(
      `[message] fromMe=${msg.fromMe} group=${chat.isGroup} chat="${chat.name}" body="${msg.body}" hasMedia=${msg.hasMedia} mentions=${JSON.stringify(msg.mentionedIds || [])}`
    );

    if (!chat.isGroup) {
      return;
    }

    if (msg.fromMe) {
      return;
    }

    const commandText = await this.extractCommandText(msg);
    if (commandText === null) {
      console.log(`Ignoring message in "${chat.name}" because the bot was not mentioned.`);
      return;
    }

    const command = commandText.split(/\s+/)[0]?.toLowerCase() || '';

    if (msg.hasMedia && command !== '!help') {
      await this.handleMentionedMediaMessage(msg);
      return;
    }

    if (!commandText || command === '!help') {
      await msg.reply(this.getHelpMessage());
      return;
    }

    if (command === '!log') {
      const foodText = commandText.replace(/!log/i, '').trim();
      if (!foodText) {
        await msg.reply('❌ Format belum lengkap. Contoh: `@bot !log 200g dada ayam panggang` atau kirim foto dengan caption `@bot !log`.');
        return;
      }

      await this.handleMentionedTextLog(msg, foodText);
      return;
    }
    await msg.reply('❓ Perintah belum dikenali. Kirim `@bot !help` untuk melihat cara pakai.');
  }

  private async handleMentionedTextLog(msg: any, foodText: string): Promise<void> {
    if (!this.aiService.isConfigured()) {
      await msg.reply('❌ GEMINI_API_KEY belum disetel. Tambahkan dulu di file .env agar analisis bisa jalan.');
      return;
    }

    const processingMsg = await msg.reply(`📝 Processing text entry: "${foodText}"...`);

    try {
      const macros = await this.aiService.analyzeTextPayload(foodText);
      await processingMsg.delete(true);
      await msg.reply(this.formatMacroResponse(macros));
    } catch (error) {
      console.error('Failed to analyze text payload:', error);
      await msg.reply(this.getFriendlyErrorMessage(error, '❌ Gagal menganalisis log teks. Coba tulis makanan dan porsinya lebih jelas ya.'));
    }
  }

  private async handleMentionedMediaMessage(msg: any): Promise<void> {
    if (!this.aiService.isConfigured()) {
      await msg.reply('❌ GEMINI_API_KEY belum disetel. Tambahkan dulu di file .env agar analisis foto bisa jalan.');
      return;
    }

    const processingMsg = await msg.reply('📸 Food photo detected! Analyzing nutrients, hold tight...');

    try {
      const media = await msg.downloadMedia();
      if (!media?.data || !media.mimetype) {
        throw new Error('Media download returned no data.');
      }

      const macros = await this.aiService.analyzeImagePayload(media.data, media.mimetype);
      await processingMsg.delete(true);
      await msg.reply(this.formatMacroResponse(macros));
    } catch (error) {
      console.error('Failed to analyze image payload:', error);
      await msg.reply(this.getFriendlyErrorMessage(error, '❌ Ups, fotonya belum berhasil diproses. Coba kirim ulang dengan gambar yang lebih jelas.'));
    }
  }

  private async extractCommandText(msg: any): Promise<string | null> {
    const body = typeof msg.body === 'string' ? msg.body.trim() : '';
    if (!body && !msg.hasMedia) {
      return null;
    }

    if (await this.hasStructuredMention(msg)) {
      return this.normalizeCommandText(body);
    }

    return this.extractTextTriggeredCommand(body);
  }

  private async hasStructuredMention(msg: any): Promise<boolean> {
    if (!this.botWid) {
      return false;
    }

    const mentionedIds = (Array.isArray(msg.mentionedIds) ? msg.mentionedIds : [])
      .map((id: unknown) => this.serializeWhatsAppId(id))
      .filter(Boolean) as string[];

    if (mentionedIds.length === 0) {
      return false;
    }

    const directBotId = this.serializeWhatsAppId(this.botWid);
    if (directBotId && mentionedIds.includes(directBotId)) {
      return true;
    }

    const botKeys = new Set(this.getComparableIdKeys(directBotId));
    for (const mentionedId of mentionedIds) {
      for (const key of this.getComparableIdKeys(mentionedId)) {
        if (botKeys.has(key)) {
          return true;
        }
      }
    }

    try {
      const mappings = await this.client.getContactLidAndPhone([directBotId, ...mentionedIds]);
      const botMapping = mappings[0];
      const botResolvedIds = [directBotId, botMapping?.lid, botMapping?.pn]
        .map((value) => this.serializeWhatsAppId(value))
        .filter(Boolean) as string[];
      const botResolvedKeys = new Set(botResolvedIds.flatMap((value) => this.getComparableIdKeys(value)));

      for (const mapping of mappings.slice(1)) {
        const mentionResolvedIds = [mapping?.lid, mapping?.pn]
          .map((value) => this.serializeWhatsAppId(value))
          .filter(Boolean) as string[];

        for (const resolvedId of mentionResolvedIds) {
          for (const key of this.getComparableIdKeys(resolvedId)) {
            if (botResolvedKeys.has(key)) {
              return true;
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to resolve mention IDs:', error);
    }

    return false;
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

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private serializeWhatsAppId(value: unknown): string | null {
    if (!value) {
      return null;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'object' && value !== null && '_serialized' in value) {
      const serialized = (value as { _serialized?: unknown })._serialized;
      return typeof serialized === 'string' ? serialized : null;
    }

    if (typeof value === 'object' && value !== null) {
      const maybeWid = value as {
        user?: unknown;
        server?: unknown;
        id?: unknown;
      };

      if (typeof maybeWid.user === 'string' && typeof maybeWid.server === 'string') {
        return `${maybeWid.user}@${maybeWid.server}`;
      }

      if (maybeWid.id) {
        return this.serializeWhatsAppId(maybeWid.id);
      }
    }

    return null;
  }

  private getComparableIdKeys(id: string | null): string[] {
    if (!id) {
      return [];
    }

    const bareId = id.toLowerCase();
    const userPart = bareId.split('@')[0];
    const digitPart = userPart.replace(/\D/g, '');

    return [...new Set([bareId, userPart, digitPart].filter(Boolean))];
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

  private formatMacroResponse(data: MacroEstimate): string {
    return (
      '🍽️ *Nutrient Log Verified!*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      `📝 *Menu:* ${data.foodName}\n\n` +
      `🔥 *Kalori:* ${data.calories} kcal\n` +
      `💪 *Protein:* ${data.protein}g\n` +
      `🍞 *Karbohidrat:* ${data.carbs}g\n` +
      `🥗 *Serat:* ${data.fiber}g\n` +
      '━━━━━━━━━━━━━━━━━━'
    );
  }

  private getFriendlyErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof AIServiceError) {
      return error.userMessage;
    }

    return fallback;
  }
}
