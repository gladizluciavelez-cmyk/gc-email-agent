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
      // One user's failure (expired token, no org yet) shouldn't stop the others.
      try {
        results[user.id] = await syncUserGmail(user.id, days);
      } catch (err) {
        results[user.id] = { error: err instanceof Error ? err.message : "Unknown error" };
      }
    }

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Email agent sync failed", err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

// Runs `worker` over `items` with at most `limit` running concurrently,
// instead of either fully sequential (slow, risks the function timeout) or
// fully parallel (risks bursting past Gmail/Anthropic rate limits).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function runNext(): Promise<void> {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function syncUserGmail(userId: string, days: number) {
  // Every email is stored under the user's organization so customers only ever
  // see their own mail. orgId is created by the dashboard app at first sign-in.
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
  if (!owner?.orgId) {
    throw new Error("User has no organization yet — sign in to the dashboard once, then sync again.");
  }
  const orgId = owner.orgId;

  const gmail = await getGmailClient(userId);

  const list = await gmail.users.messages.list({
    userId: "me",
    q: `newer_than:${days}d -category:promotions -category:social`,
    maxResults: 25,
  });

  const messageIds = list.data.messages?.map((m) => m.id!) ?? [];

  // Filter out ones we've already synced before doing any of the expensive
  // Gmail-fetch + Anthropic-classify work below.
  const existing = await prisma.emailRecord.findMany({
    where: { gmailId: { in: messageIds } },
    select: { gmailId: true },
  });
  const existingIds = new Set(existing.map((e: { gmailId: string }) => e.gmailId));

  // Emails synced before mailbox tracking have no owner. A Gmail message id
  // only ever exists in one mailbox, so if this user's inbox returns it, it is
  // theirs: claim it.
  if (existingIds.size > 0) {
    await prisma.emailRecord.updateMany({
      where: { gmailId: { in: Array.from(existingIds) }, orgId, userId: null },
      data: { userId },
    });
  }
  const newIds = messageIds.filter((id) => !existingIds.has(id));
  const skipped = messageIds.length - newIds.length;

  // Process new messages with limited concurrency (5 at a time) rather than
  // one at a time — sequential processing of a backlog easily blows past
  // Vercel's function time limit; too much concurrency risks rate limits.
  const outcomes = await mapWithConcurrency(newIds, 5, async (gmailId) => {
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
    const receivedAt = dateHeader ? new Date(dateHeader) : new Date();

    const classification = await classifyEmail({ from, subject, body, receivedAt });

    const meetingAt = classification.meetingAt ? new Date(classification.meetingAt) : null;
    // Guard against a parse failure or an obviously-wrong (past) date rather
    // than trusting the model's ISO string blindly.
    const validMeetingAt =
      meetingAt && !isNaN(meetingAt.getTime()) && meetingAt.getTime() > Date.now()
        ? meetingAt
        : null;

    await prisma.emailRecord.create({
      data: {
        orgId,
        userId,
        gmailId,
        threadId: full.data.threadId ?? undefined,
        from,
        subject,
        receivedAt,
        snippet: full.data.snippet ?? undefined,
        category: classification.category,
        summary: classification.summary,
        actionItem: classification.actionItem ?? undefined,
        requiresReply: classification.requiresReply,
        meetingTitle: validMeetingAt ? classification.meetingTitle ?? undefined : undefined,
        meetingAt: validMeetingAt ?? undefined,
        meetingAddress: validMeetingAt ? classification.meetingAddress ?? undefined : undefined,
        bidProjectNumber: classification.bidProjectNumber ?? undefined,
        bidAgencyShort: classification.bidAgencyShort ?? undefined,
        bidSummary: classification.bidSummary ?? undefined,
        bidAddress: classification.bidAddress ?? undefined,
      },
    });
  });

  return { scanned: messageIds.length, created: outcomes.length, skipped };
}
