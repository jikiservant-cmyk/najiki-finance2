import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import {
  handleSmsSendRequested,
  handlePaymentRequested,
  handlePaymentCompleted,
} from '@/lib/inngest/functions'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    handleSmsSendRequested,
    handlePaymentRequested,
    handlePaymentCompleted,
  ],
})
