const fs = require('fs');
let schema = fs.readFileSync('prisma/schema.prisma', 'utf8');

if (!schema.includes('model Message')) {
  const messageModel = `
model Message {
  id              String       @id @default(cuid())
  applicationId   String       @map("application_id")
  application     Application  @relation(fields: [applicationId], references: [id])
  tenantId        String?      @map("tenant_id")
  tenant          Tenant?      @relation(fields: [tenantId], references: [id])
  providerId      String?      @map("provider_id")
  provider        Provider?    @relation(fields: [providerId], references: [id])
  reference       String       @unique
  recipient       String
  message         String
  status          String       @default("pending")
  cost            Decimal      @default(0) @db.Decimal(14, 2)
  providerMessageId String?    @map("provider_message_id")
  metadata        String       @default("{}")
  createdAt       DateTime     @map("created_at") @default(now())
  updatedAt       DateTime     @map("updated_at") @updatedAt

  @@index([applicationId])
  @@index([providerId])
  @@index([status])
  @@index([createdAt])
  @@map("messages")
  @@schema("public")
}
`;
  schema += messageModel;
  
  // Add messages Message[] to Application
  schema = schema.replace(/internalNotifications InternalNotification\[\]/, 'internalNotifications InternalNotification[]\n  messages              Message[]');
  // Add messages Message[] to Provider
  schema = schema.replace(/webhookLogs    WebhookLog\[\]/, 'webhookLogs    WebhookLog[]\n  messages       Message[]');
  // Add messages Message[] to Tenant
  schema = schema.replace(/paymentIntents PaymentIntent\[\]/, 'paymentIntents PaymentIntent[]\n  messages       Message[]');

  fs.writeFileSync('prisma/schema.prisma', schema);
  console.log("Schema updated");
} else {
  console.log("Schema already has Message model");
}
