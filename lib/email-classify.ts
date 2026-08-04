import { anthropic, CLAUDE_MODEL } from "./anthropic";

export interface EmailClassification {
  category:
    | "SUBCONTRACTOR_UPDATE"
    | "PERMIT"
    | "BID_INVITE"
    | "CLIENT"
    | "SCHEDULING"
    | "OTHER";
  summary: string;
  actionItem: string | null;
  requiresReply: boolean;
  projectHint: string | null;
  meetingTitle: string | null;
  meetingAt: string | null; // ISO 8601 with explicit US Eastern offset, or null
  meetingAddress: string | null;
}

const SYSTEM_PROMPT = `You triage inbound email for a general contractor (GC) in
South Florida. Classify each email and extract what the GC actually needs to
know and do.

Categories:
- SUBCONTRACTOR_UPDATE: progress update, schedule change, or question from a sub
- PERMIT: permit submission, approval, rejection, or inspection notice
- BID_INVITE: invitation to bid, pre-bid meeting notice, addendum
- CLIENT: message from the property owner/client
- SCHEDULING: meeting requests, calendar coordination
- OTHER: anything else (marketing, receipts, etc.)

Mandatory pre-bid / pre-proposal meeting extraction — read carefully:
Some BID_INVITE emails announce a mandatory or non-mandatory pre-bid meeting
with a specific date, time, and location. Extract these into meetingTitle,
meetingAt, and meetingAddress ONLY when the date, time, AND location are
stated explicitly in the email's own text below. Missing a mandatory pre-bid
meeting can disqualify a GC from bidding entirely, so accuracy matters more
than completeness here:
- If the email says something like "see attached" or "details in the RFP
  document" and the actual date/time/location aren't spelled out in the text
  you were given, leave all three fields null. Do NOT guess, infer, or
  extract a date from a filename or a generic reference to an attachment.
- If a date is stated but the year is ambiguous, assume the meeting is in the
  future relative to when this email was received (given below), not the past.
- Convert the time to ISO 8601 with an explicit UTC offset for US Eastern
  Time on that specific date (-04:00 for EDT, roughly mid-March to early
  November; -05:00 for EST otherwise). Example: "10:00 AM" on July 15 2026
  becomes "2026-07-15T10:00:00-04:00".
- meetingAddress should be the physical address as written (or "Virtual /
  see email for link" if it's explicitly a remote meeting). Don't fabricate
  an address that isn't in the text.
- meetingTitle should be short, e.g. "Pre-Bid Meeting — City of Tamarac Road
  Resurfacing Project".
If none of this applies to the email, all three fields are null.

Respond with ONLY a JSON object matching this shape, no prose:
{
  "category": "...",
  "summary": "one sentence, plain language",
  "actionItem": "what the GC needs to do, or null if none",
  "requiresReply": true|false,
  "projectHint": "best guess at project name/address mentioned, or null",
  "meetingTitle": "... or null",
  "meetingAt": "ISO 8601 with -04:00/-05:00 offset, or null",
  "meetingAddress": "... or null"
}`;

export async function classifyEmail(params: {
  from: string;
  subject: string;
  body: string;
  receivedAt: Date;
}): Promise<EmailClassification> {
  const { from, subject, body, receivedAt } = params;

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Email received: ${receivedAt.toISOString()}\nFrom: ${from}\nSubject: ${subject}\n\nBody:\n${body.slice(0, 6000)}`,
      },
    ],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("");

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return {
      category: "OTHER",
      summary: subject,
      actionItem: null,
      requiresReply: false,
      projectHint: null,
      meetingTitle: null,
      meetingAt: null,
      meetingAddress: null,
    };
  }
}
