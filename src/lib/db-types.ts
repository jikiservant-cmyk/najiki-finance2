// ============================================================================
// DB ROW TYPES
// These mirror payment_service_schema.sql exactly. Keep these two files in
// sync manually for now - if you wire up Supabase's type generator later
// (`supabase gen types typescript`), it can replace this file entirely.
// ============================================================================

export type PaymentStatus =
  | "pending"
  | "processing"
  | "success"
  | "failed"
  | "expired"
  | "cancelled";

export type NotificationStatus =
  | "pending"
  | "delivered"
  | "failed_retrying"
  | "failed_exhausted";

export interface Application {
  id: string;
  code: string;
  name: string;
  base_url: string;
  webhook_path: string;
  internal_secret_ref: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Provider {
  id: string;
  code: string;
  name: string;
  credentials_ref: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Tenant {
  id: string;
  application_id: string;
  code: string;
  name: string;
  default_provider_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PaymentType {
  id: string;
  application_id: string;
  code: string;
  description: string | null;
  created_at: string;
}

export interface PaymentIntent {
  id: string;
  application_id: string;
  tenant_id: string | null;
  payment_type_id: string | null;
  external_entity_id: string | null;
  reference: string;
  idempotency_key: string;
  amount: number;
  currency: string;
  phone_number: string | null;
  provider_id: string;
  provider_payment_id: string | null;
  status: PaymentStatus;
  metadata: Record<string, unknown>;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PaymentTransaction {
  id: string;
  payment_intent_id: string;
  status: PaymentStatus;
  raw_provider_response: unknown | null;
  note: string | null;
  created_at: string;
}

export interface WebhookLog {
  id: string;
  provider_id: string;
  payment_intent_id: string | null;
  payload: unknown;
  headers: Record<string, string> | null;
  signature_valid: boolean;
  processed: boolean;
  processing_error: string | null;
  created_at: string;
}

export interface InternalNotification {
  id: string;
  payment_intent_id: string;
  application_id: string;
  url: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  attempt_count: number;
  max_attempts: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  last_response_status: number | null;
  last_response_body: string | null;
  created_at: string;
  updated_at: string;
}