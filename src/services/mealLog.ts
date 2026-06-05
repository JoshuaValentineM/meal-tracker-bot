import { randomUUID } from 'node:crypto';
import type { MealLog, MealLogRow } from '../types/meal-log.js';

export class MealLogService {
  private readonly supabaseUrl: string | null;
  private readonly serviceRoleKey: string | null;
  private readonly mealLogColumns: string;

  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '') || null;
    this.serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
    this.mealLogColumns = [
      'id',
      'created_at',
      'group_jid',
      'group_name',
      'sender_jid',
      'sender_name',
      'message_id',
      'source_type',
      'input_text',
      'food_name',
      'calories',
      'protein_g',
      'carbs_g',
      'fiber_g',
      'ai_model',
      'raw_estimate_json',
      'notes',
      'deleted_at',
    ].join(',');
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

  async getMealLogsForDateRange(startIso: string, endIso: string): Promise<MealLog[]> {
    const params = new URLSearchParams({
      select: this.mealLogColumns,
      created_at: `gte.${startIso}`,
      order: 'created_at.desc',
    });
    params.append('created_at', `lt.${endIso}`);
    params.append('deleted_at', 'is.null');

    const rows = await this.fetchMealLogRows(params);
    return rows.map((row) => this.toMealLog(row));
  }

  async getRecentMealLogs(limit: number): Promise<MealLog[]> {
    const params = new URLSearchParams({
      select: this.mealLogColumns,
      deleted_at: 'is.null',
      order: 'created_at.desc',
      limit: String(limit),
    });

    const rows = await this.fetchMealLogRows(params);
    return rows.map((row) => this.toMealLog(row));
  }

  async softDeleteMealLog(id: string, deletedAt: string): Promise<void> {
    const params = new URLSearchParams({
      id: `eq.${id}`,
    });

    const response = await this.request(`/rest/v1/meal_logs?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ deleted_at: deletedAt }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to soft-delete meal log in Supabase: ${response.status} ${details}`);
    }
  }

  private async fetchMealLogRows(params: URLSearchParams): Promise<MealLogRow[]> {
    const response = await this.request(`/rest/v1/meal_logs?${params.toString()}`);

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to query meal logs from Supabase: ${response.status} ${details}`);
    }

    return (await response.json()) as MealLogRow[];
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.supabaseUrl || !this.serviceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured to access meal logs.');
    }

    return fetch(`${this.supabaseUrl}${path}`, {
      ...init,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        ...init.headers,
      },
    });
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

  private toMealLog(row: MealLogRow): MealLog {
    return {
      id: row.id,
      createdAt: row.created_at || new Date().toISOString(),
      groupJid: row.group_jid,
      groupName: row.group_name,
      senderJid: row.sender_jid,
      senderName: row.sender_name,
      messageId: row.message_id,
      sourceType: row.source_type,
      inputText: row.input_text,
      foodName: row.food_name,
      calories: row.calories,
      protein: row.protein_g,
      carbs: row.carbs_g,
      fiber: row.fiber_g,
      aiModel: row.ai_model,
      rawEstimateJson: row.raw_estimate_json,
      notes: row.notes,
      deletedAt: row.deleted_at,
    };
  }

  private withoutUndefined(row: MealLogRow): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
  }
}
