import { randomUUID } from 'node:crypto';
import type { MealLog, MealLogRow } from '../types/meal-log.js';

export class MealLogService {
  private readonly supabaseUrl: string | null;
  private readonly serviceRoleKey: string | null;

  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '') || null;
    this.serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  }

  isConfigured(): boolean {
    return Boolean(this.supabaseUrl && this.serviceRoleKey);
  }

  async saveMealLog(mealLog: MealLog): Promise<void> {
    if (!this.supabaseUrl || !this.serviceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured to save meal logs.');
    }

    const response = await fetch(`${this.supabaseUrl}/rest/v1/meal_logs`, {
      method: 'POST',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(this.withoutUndefined(this.toRow(mealLog))),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to save meal log to Supabase: ${response.status} ${details}`);
    }
  }

  private toRow(mealLog: MealLog): MealLogRow {
    return {
      id: mealLog.id || randomUUID(),
      created_at: mealLog.createdAt,
      group_jid: mealLog.groupJid,
      group_name: mealLog.groupName,
      sender_jid: mealLog.senderJid,
      sender_name: mealLog.senderName,
      message_id: mealLog.messageId,
      source_type: mealLog.sourceType,
      input_text: mealLog.inputText,
      food_name: mealLog.foodName,
      calories: mealLog.calories,
      protein_g: mealLog.protein,
      carbs_g: mealLog.carbs,
      fiber_g: mealLog.fiber,
      ai_model: mealLog.aiModel,
      raw_estimate_json: mealLog.rawEstimateJson,
      notes: mealLog.notes,
      deleted_at: mealLog.deletedAt,
    };
  }

  private withoutUndefined(row: MealLogRow): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
  }
}
