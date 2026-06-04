import { GoogleGenAI, Type } from '@google/genai';

export interface MacroEstimate {
  foodName: string;
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
}

export class AIServiceError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'AIServiceError';
    this.userMessage = userMessage;
  }
}

const MACRO_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    foodName: {
      type: Type.STRING,
      description: 'Nama makanan dalam Bahasa Indonesia.',
    },
    calories: {
      type: Type.INTEGER,
      description: 'Estimasi total kalori dalam kcal.',
    },
    protein: {
      type: Type.INTEGER,
      description: 'Estimasi total protein dalam gram.',
    },
    carbs: {
      type: Type.INTEGER,
      description: 'Estimasi total karbohidrat dalam gram.',
    },
    fiber: {
      type: Type.INTEGER,
      description: 'Estimasi total serat dalam gram.',
    },
  },
  required: ['foodName', 'calories', 'protein', 'carbs', 'fiber'],
};

export class AIService {
  private readonly client: GoogleGenAI | null;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    this.model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash-lite';
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getModelName(): string {
    return this.model;
  }

  async analyzeTextPayload(input: string): Promise<MacroEstimate> {
    return this.wrapModelCall(async () => {
      const client = this.getClient();
      const response = await client.models.generateContent({
        model: this.model,
        contents: [
          {
            text:
              'Kamu adalah asisten nutrisi yang fokus pada makanan Indonesia. ' +
              'Berikan estimasi makro yang realistis berdasarkan porsi normal jika jumlah tidak disebutkan.',
          },
          {
            text: `Hitung makro untuk log makanan berikut: "${input}".`,
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: MACRO_RESPONSE_SCHEMA,
        },
      });

      return this.parseMacroResponse(response.text);
    });
  }

  async analyzeImagePayload(base64Data: string, mimeType: string): Promise<MacroEstimate> {
    return this.wrapModelCall(async () => {
      const client = this.getClient();
      const response = await client.models.generateContent({
        model: this.model,
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType,
            },
          },
          {
            text:
              'Kamu adalah asisten nutrisi yang fokus pada makanan Indonesia. ' +
              'Analisis makanan pada gambar, identifikasi komponen utamanya, lalu estimasikan total kalori, protein, karbohidrat, dan serat secara realistis. ' +
              'Jika terlihat mi instan dengan telur, pakai asumsi 1 bungkus mi instan standar dan 1 butir telur kecuali gambar jelas menunjukkan porsi lain.',
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: MACRO_RESPONSE_SCHEMA,
        },
      });

      return this.parseMacroResponse(response.text);
    });
  }

  async estimateFromText(input: string): Promise<MacroEstimate> {
    return this.analyzeTextPayload(input);
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }

    return this.client;
  }

  private parseMacroResponse(payload: string | undefined): MacroEstimate {
    if (!payload) {
      throw new Error('Gemini returned an empty response.');
    }

    const parsed = JSON.parse(payload) as Partial<MacroEstimate>;
    const normalized: MacroEstimate = {
      foodName: parsed.foodName?.trim() || 'Menu tidak diketahui',
      calories: this.toWholeNumber(parsed.calories),
      protein: this.toWholeNumber(parsed.protein),
      carbs: this.toWholeNumber(parsed.carbs),
      fiber: this.toWholeNumber(parsed.fiber),
    };

    return normalized;
  }

  private toWholeNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.round(parsed));
      }
    }

    return 0;
  }

  private async wrapModelCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof AIServiceError) {
      return error;
    }

    if (error instanceof Error) {
      const apiError = error as Error & { status?: number };
      const message = error.message || 'Unknown Gemini API error.';

      if (apiError.status === 429) {
        return new AIServiceError(
          message,
          `❌ Kuota Gemini untuk model \`${this.model}\` sedang habis atau belum aktif. Cek billing/quota Google AI Studio lalu coba lagi.`
        );
      }

      if (apiError.status === 401 || apiError.status === 403) {
        return new AIServiceError(
          message,
          '❌ API key Gemini tidak valid atau belum punya izin akses ke model ini.'
        );
      }

      if (message.includes('empty response')) {
        return new AIServiceError(
          message,
          '❌ Gemini tidak mengembalikan hasil yang bisa dibaca. Coba kirim ulang.'
        );
      }

      return error;
    }

    return new Error('Unknown Gemini API error.');
  }
}
