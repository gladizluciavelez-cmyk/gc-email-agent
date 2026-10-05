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
  bidProjectNumber: string | null;
  bidAgencyShort: string | null;
  bidSummary: string | null;
  bidAddress: string | null;
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

Bid-opportunity title parsing — for BID_INVITE emails only:
Agencies name their solicitation emails very inconsistently — subjects range
from clean ("City of Tamarac — Road Resurfacing, Project No. 2026-14") to
dense run-ons ("New Opportunity Issued by Central Florida Expressway
Authority: Invitation to Bid for SR 453 at SR 46 Safety Improvements
[Project No. 453-453]"). Rather than trying to regex-parse these, extract
four pieces so the dashboard can build a clean, consistent title:
- bidProjectNumber: the project/solicitation number as written (e.g.
  "453-453", "2026-14"), without surrounding brackets or the words "Project
  No." — just the number/code itself. Null if none is stated.
- bidAgencyShort: a short, recognizable form of the issuing agency — prefer
  a natural abbreviation if the agency commonly uses one (e.g. "Central
  Florida Expressway Authority" -> "CFE Authority", "Miami-Dade County
  Public Schools" -> "Miami-Dade Schools"), otherwise just a shortened
  version of the full name. Do not invent an abbreviation that isn't a
  reasonable shortening of the actual name. Null if no agency is identifiable.
- bidSummary: a 1-3 word plain description of what the project actually is,
  using the email's own wording where possible (e.g. "Safety Improvements",
  "Road Resurfacing", "Roof Replacement"). Do not editorialize or guess a
  trade that isn't indicated by the text — if the email says "Safety
  Improvements", use that, not a specific trade you're inferring. Null if
  genuinely unclear.
- bidAddress: the project's physical address/location as stated. If the
  email lists more than one distinct address/location for the same project,
  set this to exactly "Multiple addresses" instead of picking one. Null if
  no address is given.

Respond with ONLY a JSON object matching this shape, no prose:
{
  "category": "...",
  "summary": "one sentence, plain language",
  "actionItem": "what the GC needs to do, or null if none",
  "requiresReply": true|false,
  "projectHint": "best guess at project name/address mentioned, or null",
  "meetingTitle": "... or null",
  "meetingAt": "ISO 8601 with -04:00/-05:00 offset, or null",
  "meetingAddress": "... or null",
  "bidProjectNumber": "... or null",
  "bidAgencyShort": "... or null",
  "bidSummary": "... or null",
  "bidAddress": "... or null"
}`;

export async function classifyEmail(params: {
  from: string;
  subject: string;
  body: string;
  receivedAt: Date;
}): Promise<EmailClassification> {
  const { from, subject, body, receivedAt } = params;

  const fallback: EmailClassification = {
    category: "OTHER",
    summary: subject,
    actionItem: null,
    requiresReply: false,
    projectHint: null,
    meetingTitle: null,
    meetingAt: null,
    meetingAddress: null,
    bidProjectNumber: null,
    bidAgencyShort: null,
    bidSummary: null,
    bidAddress: null,
  };

  // A bad/expired ANTHROPIC_API_KEY, a rate limit, or a transient network
  // error should degrade this one email to the fallback classification
  // rather than throwing and aborting the entire sync batch — otherwise one
  // bad key means zero emails get saved at all, and the dashboard sees a
  // confusing crash instead of an inbox full of "OTHER" emails.
  let message;
  try {
    message = await anthropic.messages.create({
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
  } catch (err) {
    console.error("Anthropic classify call failed, using fallback classification", err);
    return fallback;
  }

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("");

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    return fallback;
  }
}
