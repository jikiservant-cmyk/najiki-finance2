/** The allowlist is an ongoing authorization policy, not just a bootstrap list. */
export function isAllowedSuperAdminEmail(email: string | null | undefined, allowlist: string | null | undefined): boolean {
  if (!email || !allowlist) return false
  const normalized = email.trim().toLowerCase()
  return !!normalized && allowlist.split(',').some((entry) => entry.trim().toLowerCase() === normalized)
}
