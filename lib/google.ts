import { google } from "googleapis";
import { prisma } from "./prisma";

/**
 * Builds an authenticated Gmail client for a user, using the refresh token
 * NextAuth stored on their Account row (in the shared DB) when they signed
 * in via the dashboard app. This service never runs the OAuth consent flow
 * itself — it only ever refreshes tokens someone else's sign-in produced.
 */
export async function getGmailClient(userId: string) {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });

  if (!account?.refresh_token) {
    throw new Error(
      `No Google refresh token on file for user ${userId}. They need to sign ` +
        "in via the dashboard app and grant Gmail access first."
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: account.refresh_token });

  return google.gmail({ version: "v1", auth: oauth2Client });
}
