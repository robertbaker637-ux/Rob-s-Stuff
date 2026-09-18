// Plaid error sanitization (rv2.4).
//
// A Plaid SDK error's `response.data` (Plaid's own error body) is safe —
// it never echoes back an access_token. What's NOT safe is the error's
// `config`/`request`, which is the axios request that was sent and DOES
// contain the access_token for any authenticated call. Every route
// handler must catch Plaid errors through this sanitizer before logging
// or rethrowing — never log or rethrow the raw caught error object.

export interface SanitizedPlaidError {
  message: string;
  plaidErrorCode?: string;
}

export function sanitizePlaidError(err: unknown): SanitizedPlaidError {
  const data = (err as { response?: { data?: { error_code?: string; error_message?: string } } })
    ?.response?.data;

  if (data?.error_code) {
    return {
      message: data.error_message ?? `Plaid error (${data.error_code})`,
      plaidErrorCode: data.error_code,
    };
  }

  return { message: err instanceof Error ? err.message : "Unknown Plaid error" };
}
