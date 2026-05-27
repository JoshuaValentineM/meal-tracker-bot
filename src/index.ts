import { WhatsAppService } from './services/whatsapp.js';
import * as dotenv from 'dotenv';

dotenv.config();

console.log('Starting Meal Tracker Server...');
const bot = new WhatsAppService();
bot.initialize().catch((error) => {
  console.error('Failed to initialize Meal Tracker Bot:', error);
  process.exitCode = 1;
});
