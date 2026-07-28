import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "../lib/prisma";
import { getGmailClient } from "../lib/google";
import { extractPlainText, getHeader } from "../lib/gmail-parse";
import { classifyEmail } from "../lib/email-classify";

/**
 * The entire gc-email-agent service in one endpoint. Two ways to call it:
 *
 *  - Cron mode (Vercel Cron, see vercel.json): GET with no userId, header
 *    `Authorization: Bearer ${CRON_SECRET}`. Loops over every user who has
 *    connected Google and syncs each of their inboxes.
 *
 *  - On-demand mode: GET/POST with ?userId=..., header
 *    `Authorization: Bearer ${AGENT_SHARED_SECRET}`. Called server-to-server
 *    from the dashboard app's /api/gmail/trigger-sync route when someone
 *    clicks "Sync Gmail."
 *
 * Either way, results are written straight to the shared EmailRecord table;
 * the dashboard app just reads that table, it doesn't call Gmail itself.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isOnDemand = authHeader === `Bearer ${process.env.AGENT_SHARED_SECRET}`;

  if (!isCron && !isOnDemand) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  const days = Number((req.query.days as string) ?? "2");

  try {
    const targetUsers = userId
      ? [{ id: userId }]
      : await prisma.user.findMany({
          where: { googleConnected: true },
          select: { id: true },
        });

    const results: Record<string, unknown> = {};

    for (const user of targetUsers) {
      results[user.id] = await syncUserGmail(user.id, days);
    }

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Email agent sync failed", err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

async function syncUserGmail(userId: string, days: number) {
  const gmail = await getGmailClient(userId);

  const list = await gmail.users.messages.list({
    userId: "me",
    q: `newer_than:${days}d -category:promotions -category:social`,
    maxResults: 25,
  });

  const messageIds = list.data.messages?.map((m) => m.id!) ?? [];
  let created = 0;
  let skipped = 0;

  for (const gmailId of messageIds) {
    const exists = await prisma.emailRecord.findUnique({ where: { gmailId } });
    if (exists) {
      skipped++;
      continue;
    }

    const full = await gmail.users.messages.get({
      userId: "me",
      id: gmailId,
      format: "full",
    });

    const headers = full.data.payload?.headers;
    const from = getHeader(headers, "From");
    const subject = getHeader(headers, "Subject") || "(no subject)";
    const dateHeader = getHeader(headers, "Date");
    const body = extractPlainText(full.data.payload ?? undefined);

    const classification = await classifyEmail({ from, subject, body });

    await prisma.emailRecord.create({
      data: {
        gmailId,
        threadId: full.data.threadId ?? undefined,
        from,
        subject,
        receivedAt: dateHeader ? new Date(dateHeader) : new Date(),
        snippet: full.data.snippet ?? undefined,
        category: classification.category,
        summary: classification.summary,
        actionItem: classification.actionItem ?? undefined,
        requiresReply: classification.requiresReply,
      },
    });
    created++;
  }

  return { scanned: messageIds.length, created, skipped };
}
