"use client";

// Launches Plaid Link. Not wired into Dashboard/Budget navigation this
// pass (consistent with rv2.3's "no new UI page" call) — present and
// correctly built against react-plaid-link's documented API, but
// unexercised without a live Plaid project.

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";

export function PlaidLinkButton({ userId }: { userId: string }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/plaid/create-link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    })
      .then((res) => res.json())
      .then((data) => setLinkToken(data.linkToken ?? null))
      .catch(() => setLinkToken(null));
  }, [userId]);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken) => {
      await fetch("/api/plaid/exchange-public-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicToken, userId }),
      });
    },
    [userId]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess,
  });

  return (
    <button
      type="button"
      onClick={() => open()}
      disabled={!ready || !linkToken}
      className="rounded-lg bg-status-good px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
    >
      Connect an account
    </button>
  );
}
