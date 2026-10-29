/**
 * Masking a phone number for anything that leaves the server.
 *
 * The dashboard and the partner-facing status endpoint both show recipients,
 * and neither needs the full number: the caller already knows who it texted, and
 * the value is a customer's personal data. Keeping one implementation means the
 * two surfaces cannot drift into one of them leaking a full MSISDN.
 *
 * Zero imports — reachable from the type-stripped test runner.
 */
export function maskRecipient(recipient: string): string {
  const value = String(recipient || '')
  if (value.length <= 4) return value
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(value.length - 6, 1))}${value.slice(-2)}`
}
