const assert = require('node:assert/strict');
const test = require('node:test');
const { SupabaseWhatsAppAuthStore } = require('../dist/services/whatsappAuth.js');

function createSupabaseFetchMock() {
  const rows = new Map();

  return {
    rows,
    fetch: async (url, init = {}) => {
      const requestUrl = new URL(url);
      const method = init.method || 'GET';

      if (method === 'POST') {
        for (const row of JSON.parse(init.body)) {
          rows.set(`${row.session_id}:${row.key_type}:${row.key_id}`, row);
        }
        return new Response(null, { status: 201 });
      }

      if (method === 'DELETE') {
        const sessionId = requestUrl.searchParams.get('session_id').replace('eq.', '');
        const keyType = requestUrl.searchParams.get('key_type').replace('eq.', '');
        const ids = parseInFilter(requestUrl.searchParams.get('key_id'));
        for (const id of ids) {
          rows.delete(`${sessionId}:${keyType}:${id}`);
        }
        return new Response(null, { status: 204 });
      }

      const sessionFilter = requestUrl.searchParams.get('session_id');
      const typeFilter = requestUrl.searchParams.get('key_type');
      const idFilter = requestUrl.searchParams.get('key_id');
      const matchingRows = [...rows.values()].filter((row) => {
        if (sessionFilter && row.session_id !== sessionFilter.replace('eq.', '')) {
          return false;
        }
        if (typeFilter && row.key_type !== typeFilter.replace('eq.', '')) {
          return false;
        }
        return !idFilter || parseInFilter(idFilter).includes(row.key_id);
      });
      return Response.json(matchingRows);
    },
  };
}

function parseInFilter(filter) {
  return filter
    .slice(4, -1)
    .split(',')
    .map((value) => value.replace(/^"|"$/g, ''));
}

test('persists credentials and binary Signal keys across auth store instances', async () => {
  const originalFetch = global.fetch;
  const supabase = createSupabaseFetchMock();
  global.fetch = supabase.fetch;

  try {
    const options = {
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'test-service-role-key',
      sessionId: 'test-session',
    };
    const firstStore = new SupabaseWhatsAppAuthStore(options);
    const firstAuth = await firstStore.useAuthState();

    assert.equal(firstAuth.state.creds.registered, false);
    firstAuth.state.creds.registered = true;
    await firstAuth.state.keys.set({
      'pre-key': {
        '1': {
          public: Buffer.from([1, 2, 3]),
          private: Buffer.from([4, 5, 6]),
        },
      },
    });
    await firstAuth.saveCreds();

    const restoredStore = new SupabaseWhatsAppAuthStore(options);
    const restoredAuth = await restoredStore.useAuthState();
    const restoredKeys = await restoredAuth.state.keys.get('pre-key', ['1']);

    assert.equal(restoredAuth.state.creds.registered, true);
    assert.deepEqual(restoredKeys['1'].public, Buffer.from([1, 2, 3]));
    assert.deepEqual(restoredKeys['1'].private, Buffer.from([4, 5, 6]));

    await restoredStore.checkHealth();
    assert.equal(restoredStore.getDiagnostics().databaseReachable, true);
    assert.equal(restoredStore.getDiagnostics().authStateStored, true);
  } finally {
    global.fetch = originalFetch;
  }
});
