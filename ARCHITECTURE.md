# Modular Monolith Architecture

This folder provides a structured way to separate business logic domains from the Next.js routing layer.

Instead of a full multi-build monorepo (which could disrupt database setup and deployment), this project uses a Modular Monolith approach mapped via TypeScript path aliases.

- Create business logic files inside these folders (e.g., `apps/messaging/sms/index.ts`).
- Import them seamlessly from Next.js routes using the `@najiki/*` alias.

## Example

```typescript
// src/app/api/sms/route.ts
import { sendSMS } from '@najiki/messaging/sms'

export async function POST(req: Request) {
  await sendSMS()
  return new Response("Sent")
}
```

This keeps code perfectly decoupled and ready for a true monorepo separation later if needed, while keeping Prisma and Next.js exactly as they are without data loss!
