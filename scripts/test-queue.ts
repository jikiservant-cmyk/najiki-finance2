import { smsQueue } from "../src/lib/sms-queue";
smsQueue.processBatch(5).then(console.log).catch(console.error);
