import { smsQueue } from '../src/lib/sms-queue';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  console.log('Running smsQueue.processBatch...');
  const results = await smsQueue.processBatch(20);
  console.log('Results:', results);
}
main();
