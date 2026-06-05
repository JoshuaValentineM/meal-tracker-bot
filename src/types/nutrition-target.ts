export type NutritionTargetField = 'calories' | 'protein' | 'carbs' | 'fiber';

export type NutritionTargetValues = Partial<Record<NutritionTargetField, number | null>>;

export interface NutritionTarget {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  senderJid: string;
  senderName?: string;
  calories?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fiber?: number | null;
  deletedAt?: string | null;
}

export interface NutritionTargetRow {
  id?: string;
  created_at?: string;
  updated_at?: string;
  sender_jid: string;
  sender_name?: string | null;
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fiber_g?: number | null;
  deleted_at?: string | null;
}
