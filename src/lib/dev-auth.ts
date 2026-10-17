/** Never allow a missing Supabase configuration to authenticate by default. */
export function allowInsecureDevAuth(environment: string | undefined, flag: string | undefined): boolean {
  return environment === 'development' && flag === 'true'
}
