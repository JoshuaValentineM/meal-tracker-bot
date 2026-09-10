import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

type AuthStateRow = {
  session_id: string;
  key_type: string;
  key_id: string;
  value: unknown;
  updated_at: string;
};

type AuthStoreDiagnostics = {
  authBackend: 'supabase';
  authSessionId: string;
  authStateStored: boolean | null;
  authRegistered: boolean | null;
  databaseConfigured: boolean;
  databaseReachable: boolean | null;
  lastDatabaseCheckAt: string | null;
};

type SupabaseWhatsAppAuthStoreOptions = {
  supabaseUrl?: string | null;
  serviceRoleKey?: string | null;
  sessionId?: string | null;
};

const AUTH_TABLE = 'whatsapp_auth_state';
const CREDS_TYPE = 'creds';
const CREDS_ID = 'creds';

export class SupabaseWhatsAppAuthStore {
  private readonly supabaseUrl: string | null;
  private readonly serviceRoleKey: string | null;
  private readonly sessionId: string;
  private currentCreds: AuthenticationCreds | null;
  private authStateStored: boolean | null;
  private databaseReachable: boolean | null;
  private lastDatabaseCheckAt: string | null;
  private writeQueue: Promise<void>;

  constructor(options: SupabaseWhatsAppAuthStoreOptions = {}) {
    this.supabaseUrl =
      options.supabaseUrl?.trim().replace(/\/+$/, '') ||
      process.env.SUPABASE_URL?.trim().replace(/\/+$/, '') ||
      null;
    this.serviceRoleKey =
      options.serviceRoleKey?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
    this.sessionId =
      options.sessionId?.trim() || process.env.WHATSAPP_SESSION_ID?.trim() || 'meal-tracker-primary';
    this.currentCreds = null;
    this.authStateStored = null;
    this.databaseReachable = null;
    this.lastDatabaseCheckAt = null;
    this.writeQueue = Promise.resolve();
  }

  public async useAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    this.assertConfigured();
    await this.writeQueue;

    const rows = await this.fetchRows(CREDS_TYPE, [CREDS_ID]);
    const storedCreds = rows[0]?.value
      ? (this.deserialize(rows[0].value) as AuthenticationCreds)
      : null;
    const creds = storedCreds || initAuthCreds();

    this.currentCreds = creds;
    this.authStateStored = storedCreds !== null;

    return {
      state: {
        creds,
        keys: {
          get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
            const result = {} as { [id: string]: SignalDataTypeMap[T] };
            if (ids.length === 0) {
              return result;
            }

            const keyRows = await this.fetchRows(type, ids);
            for (const row of keyRows) {
              let value = this.deserialize(row.value) as SignalDataTypeMap[T];
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as proto.Message.IAppStateSyncKeyData
                ) as unknown as SignalDataTypeMap[T];
              }
              result[row.key_id] = value;
            }

            return result;
          },
          set: async (data: SignalDataSet) => {
            const upserts: AuthStateRow[] = [];
            const deletes = new Map<string, string[]>();

            for (const keyType of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
              const values = data[keyType] as Record<string, unknown | null> | undefined;
              if (!values) {
                continue;
              }

              for (const [keyId, value] of Object.entries(values)) {
                if (value === null || value === undefined) {
                  const ids = deletes.get(keyType) || [];
                  ids.push(keyId);
                  deletes.set(keyType, ids);
                  continue;
                }

                upserts.push(this.createRow(keyType, keyId, value));
              }
            }

            await this.enqueueWrite(async () => {
              if (upserts.length > 0) {
                await this.upsertRows(upserts);
              }

              for (const [keyType, keyIds] of deletes) {
                await this.deleteRows(keyType, keyIds);
              }
            });
          },
        },
      },
      saveCreds: async () => {
        const credsSnapshot = this.serialize(creds);
        await this.enqueueWrite(async () => {
          await this.upsertRows([
            this.createRow(CREDS_TYPE, CREDS_ID, credsSnapshot, false),
          ]);
          this.authStateStored = true;
        });
      },
    };
  }

  public async checkHealth(): Promise<void> {
    this.lastDatabaseCheckAt = new Date().toISOString();

    if (!this.isConfigured()) {
      this.databaseReachable = false;
      return;
    }

    try {
      const params = new URLSearchParams({
        select: 'session_id',
        session_id: `eq.${this.sessionId}`,
        limit: '1',
      });
      const response = await this.request(`/rest/v1/${AUTH_TABLE}?${params.toString()}`);
      this.databaseReachable = response.ok;
    } catch {
      this.databaseReachable = false;
    }
  }

  public getDiagnostics(): AuthStoreDiagnostics {
    return {
      authBackend: 'supabase',
      authSessionId: this.sessionId,
      authStateStored: this.authStateStored,
      authRegistered: this.currentCreds ? Boolean(this.currentCreds.registered) : null,
      databaseConfigured: this.isConfigured(),
      databaseReachable: this.databaseReachable,
      lastDatabaseCheckAt: this.lastDatabaseCheckAt,
    };
  }

  private isConfigured(): boolean {
    return Boolean(this.supabaseUrl && this.serviceRoleKey);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for WhatsApp auth persistence.'
      );
    }
  }

  private async fetchRows(keyType: string, keyIds: string[]): Promise<AuthStateRow[]> {
    const params = new URLSearchParams({
      select: 'session_id,key_type,key_id,value,updated_at',
      session_id: `eq.${this.sessionId}`,
      key_type: `eq.${keyType}`,
      key_id: this.createInFilter(keyIds),
    });
    const response = await this.request(`/rest/v1/${AUTH_TABLE}?${params.toString()}`);
    await this.assertSuccessfulResponse(response, 'read WhatsApp auth state');
    this.databaseReachable = true;
    this.lastDatabaseCheckAt = new Date().toISOString();
    return (await response.json()) as AuthStateRow[];
  }

  private async upsertRows(rows: AuthStateRow[]): Promise<void> {
    const response = await this.request(
      `/rest/v1/${AUTH_TABLE}?on_conflict=session_id,key_type,key_id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      }
    );
    await this.assertSuccessfulResponse(response, 'save WhatsApp auth state');
  }

  private async deleteRows(keyType: string, keyIds: string[]): Promise<void> {
    if (keyIds.length === 0) {
      return;
    }

    const params = new URLSearchParams({
      session_id: `eq.${this.sessionId}`,
      key_type: `eq.${keyType}`,
      key_id: this.createInFilter(keyIds),
    });
    const response = await this.request(`/rest/v1/${AUTH_TABLE}?${params.toString()}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    await this.assertSuccessfulResponse(response, 'delete WhatsApp auth keys');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    this.assertConfigured();

    return fetch(`${this.supabaseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        apikey: this.serviceRoleKey as string,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        ...init.headers,
      },
    });
  }

  private async assertSuccessfulResponse(response: Response, action: string): Promise<void> {
    if (response.ok) {
      this.databaseReachable = true;
      this.lastDatabaseCheckAt = new Date().toISOString();
      return;
    }

    this.databaseReachable = false;
    this.lastDatabaseCheckAt = new Date().toISOString();
    const details = await response.text();
    throw new Error(`Failed to ${action}: ${response.status} ${details}`);
  }

  private createRow(
    keyType: string,
    keyId: string,
    value: unknown,
    serialize = true
  ): AuthStateRow {
    return {
      session_id: this.sessionId,
      key_type: keyType,
      key_id: keyId,
      value: serialize ? this.serialize(value) : value,
      updated_at: new Date().toISOString(),
    };
  }

  private createInFilter(values: string[]): string {
    const quotedValues = values.map((value) => {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    });
    return `in.(${quotedValues.join(',')})`;
  }

  private serialize(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as unknown;
  }

  private deserialize<T>(value: unknown): T {
    return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const nextWrite = this.writeQueue.then(task, task);
    this.writeQueue = nextWrite.catch(() => undefined);
    return nextWrite;
  }
}
