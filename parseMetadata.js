const fs = require('fs');

function fixFile(file) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/metadata: (.*?)\.metadata \? JSON\.parse\((.*?)\.metadata\) : \{\},/g, 
    `metadata: (() => { try { return $1.metadata ? JSON.parse($1.metadata) : {}; } catch(e) { return {}; } })(),`);
  fs.writeFileSync(file, content);
}

fixFile('src/app/api/webhooks/[provider]/route.ts');
fixFile('src/app/api/cron/sync-payments/route.ts');
fixFile('src/app/api/payments/[reference]/route.ts');
fixFile('src/app/api/webhook/route.ts');
