const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { WhatsAppService } = require('../dist/services/whatsapp.js');

function createFakeSocket() {
  return {
    ev: new EventEmitter(),
    end: async () => undefined,
  };
}

test('schedules another reconnect when a replacement socket also disconnects', async () => {
  const service = new WhatsAppService();

  try {
    const firstSocket = createFakeSocket();
    service.socket = firstSocket;
    service.socketGeneration = 1;

    await service.handleConnectionUpdate(
      {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: DisconnectReason.timedOut } } },
      },
      firstSocket,
      1
    );

    assert.equal(service.connectionState, 'reconnecting');
    assert.equal(service.reconnectAttempt, 1);
    assert.notEqual(service.reconnectTimer, null);

    service.clearReconnectTimer();

    const replacementSocket = createFakeSocket();
    service.socket = replacementSocket;
    service.socketGeneration = 2;

    await service.handleConnectionUpdate(
      {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
      },
      replacementSocket,
      2
    );

    assert.equal(service.connectionState, 'reconnecting');
    assert.equal(service.reconnectAttempt, 2);
    assert.notEqual(service.reconnectTimer, null);
  } finally {
    service.clearReconnectTimer();
  }
});

test('does not reconnect a session that WhatsApp explicitly logged out', async () => {
  const service = new WhatsAppService();
  const socket = createFakeSocket();
  service.socket = socket;
  service.socketGeneration = 1;

  await service.handleConnectionUpdate(
    {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    },
    socket,
    1
  );

  assert.equal(service.connectionState, 'logged_out');
  assert.equal(service.reconnectAttempt, 0);
  assert.equal(service.reconnectTimer, null);
  assert.equal(service.getStatus().requiresRelink, true);
});
