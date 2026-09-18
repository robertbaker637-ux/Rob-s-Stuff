// No access token exists yet at this step — this route only asks Plaid
// for a link_token, which is safe to return to the client (it's what
// Plaid Link itself needs to launch).

import { NextRequest, NextResponse } from "next/server";
import { plaidClient } from "@/lib/plaid/client";
import { buildLinkTokenRequest } from "@/lib/plaid/linkToken";
import { sanitizePlaidError } from "@/lib/plaid/errors";

export async function POST(request: NextRequest) {
  const { userId } = await request.json();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  try {
    const response = await plaidClient.linkTokenCreate(buildLinkTokenRequest({ userId }));
    return NextResponse.json({ linkToken: response.data.link_token });
  } catch (err) {
    const sanitized = sanitizePlaidError(err);
    console.error("Plaid create-link-token failed:", sanitized);
    return NextResponse.json({ error: sanitized.message }, { status: 502 });
  }
}
