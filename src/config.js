// Supabase Edge Functions base. The functions use custom session auth
// (verify_jwt = false), so no anon key is required from the browser.
export const FUNCTIONS_URL = "https://kltggicuonljcgyehcev.supabase.co/functions/v1";
export const ADMIN_API = `${FUNCTIONS_URL}/admin-api`;
