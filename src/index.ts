import { WhatsAppService } from './services/whatsapp.js';
import * as dotenv from 'dotenv';
import http from 'http';

dotenv.config();

console.log('Starting Meal Tracker Server...');

const bot = new WhatsAppService();
startHealthServerIfNeeded(bot);

bot.initialize().catch((error) => {
  console.error('Failed to initialize Meal Tracker Bot:', error);
  process.exitCode = 1;
});

function startHealthServerIfNeeded(botService: WhatsAppService): void {
  const port = process.env.PORT;
  if (!port) {
    return;
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(botService.getStatus(), null, 2));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'meal-tracker-bot' }));
  });

  server.listen(Number(port), '0.0.0.0', () => {
    console.log(`Health server listening on port ${port}.`);
  });
}
