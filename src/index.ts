import { WhatsAppService } from './services/whatsapp.js';
import * as dotenv from 'dotenv';

dotenv.config();

console.log('Starting Meal Tracker Server...');
const bot = new WhatsAppService();
bot.initialize();