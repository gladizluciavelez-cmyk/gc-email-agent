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
}

const SYSTEM_PROMPT = `You triage inbound email for a general contractor (GC).
Classify each email and extract what the GC actually needs to know and do.
Categories:
- SUBCONTRACTOR_UPDATE: progress update, schedule change, or question from a sub
- PERMIT: permit submission, approval, rejection, or inspection notice
- BID_INVITE: invitation to bid, pre-bid meeting notice, addendum
- CLIENT: message from the property owner/client
- SCHEDULING: meeting requests, calendar coordination
- OTHER: anything else (marketing, receipts, etc.)

Respond with ONLY a JSON object matching this shape, no prose:
{
  "category": "...",
  "summary": "one sentence, plain language",
  "actionItem": "what the GC needs to do, or null if none",
  "requiresReply": true|false,
  "projectHint": "best guess at project name/address mentioned, or null"
}`;

export async function classifyEmail(params: {
  from: string;
  subject: string;
  body: string;
}): Promise<EmailClassification> {
  const { from, subject, body } = params;

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `From: ${from}\nSubject: ${subject}\n\nBody:\n${body.slice(0, 6000)}`,
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
    };
  }
}
