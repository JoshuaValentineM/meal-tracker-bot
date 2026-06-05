import { randomUUID } from 'node:crypto';
import type {
  NutritionTarget,
  NutritionTargetRow,
  NutritionTargetValues,
} from '../types/nutrition-target.js';

export class NutritionTargetService {
  private readonly supabaseUrl: string | null;
  private readonly serviceRoleKey: string | null;
  private readonly nutritionTargetColumns: string;

  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '') || null;
    this.serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
    this.nutritionTargetColumns = [
      'id',
      'created_at',
      'updated_at',
      'sender_jid',
      'sender_name',
      'calories',
      'protein_g',
      'carbs_g',
      'fiber_g',
      'deleted_at',
    ].join(',');
  }

  isConfigured(): boolean {
    return Boolean(this.supabaseUrl && this.serviceRoleKey);
  }

  async getTarget(senderJid: string): Promise<NutritionTarget | null> {
    const params = new URLSearchParams({
      select: this.nutritionTargetColumns,
      sender_jid: `eq.${senderJid}`,
      deleted_at: 'is.null',
      limit: '1',
    });

    const rows = await this.fetchTargetRows(params);
    return rows[0] ? this.toTarget(rows[0]) : null;
  }

  async upsertTarget(senderJid: string, senderName: string | undefined, values: NutritionTargetValues): Promise<NutritionTarget> {
    const now = new Date().toISOString();
    const row = this.withoutUndefined({
      id: randomUUID(),
      sender_jid: senderJid,
      sender_name: senderName,
      updated_at: now,
      deleted_at: null,
      ...this.toValueRow(values),
    });

    const response = await this.request('/rest/v1/nutrition_targets?on_conflict=sender_jid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(row),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to upsert nutrition target in Supabase: ${response.status} ${details}`);
    }

    const rows = (await response.json()) as NutritionTargetRow[];
    return this.toTarget(rows[0]);
  }

  async clearTarget(senderJid: string, deletedAt: string): Promise<void> {
    await this.patchTarget(senderJid, { deleted_at: deletedAt, updated_at: deletedAt });
  }

  async clearTargetFields(senderJid: string, fields: NutritionTargetValues): Promise<NutritionTarget | null> {
    const now = new Date().toISOString();
    const row = this.withoutUndefined({
      updated_at: now,
      ...this.toValueRow(fields),
    });

    const response = await this.patchTarget(senderJid, row, 'return=representation');

    if (response === null) {
      return null;
    }

    const rows = (await response.json()) as NutritionTargetRow[];
    return rows[0] ? this.toTarget(rows[0]) : null;
  }

  private async patchTarget(
    senderJid: string,
    row: Record<string, unknown>,
    prefer = 'return=minimal'
  ): Promise<Response | null> {
    const params = new URLSearchParams({
      sender_jid: `eq.${senderJid}`,
    });
    params.append('deleted_at', 'is.null');

    const response = await this.request(`/rest/v1/nutrition_targets?${params.toString()}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: JSON.stringify(row),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to update nutrition target in Supabase: ${response.status} ${details}`);
    }

    return prefer.includes('representation') ? response : null;
  }

  private async fetchTargetRows(params: URLSearchParams): Promise<NutritionTargetRow[]> {
    const response = await this.request(`/rest/v1/nutrition_targets?${params.toString()}`);

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to query nutrition targets from Supabase: ${response.status} ${details}`);
    }

    return (await response.json()) as NutritionTargetRow[];
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.supabaseUrl || !this.serviceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured to access nutrition targets.');
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

  private toValueRow(values: NutritionTargetValues): Partial<NutritionTargetRow> {
    return {
      calories: values.calories,
      protein_g: values.protein,
      carbs_g: values.carbs,
      fiber_g: values.fiber,
    };
  }

  private toTarget(row: NutritionTargetRow): NutritionTarget {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      senderJid: row.sender_jid,
      senderName: row.sender_name || undefined,
      calories: row.calories,
      protein: row.protein_g,
      carbs: row.carbs_g,
      fiber: row.fiber_g,
      deletedAt: row.deleted_at,
    };
  }

  private withoutUndefined(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
  }
}
