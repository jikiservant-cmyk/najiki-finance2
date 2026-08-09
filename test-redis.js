const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
async function main() {
  const q = await redis.lrange('sms:queue', 0, -1);
  console.log('Queue:', q);
  const data = await redis.hvals('sms:data');
  console.log('Data:', data.length);
}
main();
