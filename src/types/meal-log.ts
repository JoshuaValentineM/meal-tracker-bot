export type MealSourceType = 'text' | 'image';

export type MealLogRawEstimateJson = Record<string, unknown>;

export interface MealLog {
  id?: string;
  createdAt: string;
  groupJid: string;
  groupName?: string;
  senderJid: string;
  senderName?: string;
  messageId?: string;
  sourceType: MealSourceType;
  inputText?: string;
  foodName: string;
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
  aiModel?: string;
  rawEstimateJson?: MealLogRawEstimateJson;
  notes?: string;
  deletedAt?: string;
}

export interface MealLogRow {
  id?: string;
  created_at?: string;
  group_jid: string;
  group_name?: string;
  sender_jid: string;
  sender_name?: string;
  message_id?: string;
  source_type: MealSourceType;
  input_text?: string;
  food_name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fiber_g: number;
  ai_model?: string;
  raw_estimate_json?: MealLogRawEstimateJson;
  notes?: string;
  deleted_at?: string;
}
