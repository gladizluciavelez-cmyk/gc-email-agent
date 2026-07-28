import type { gmail_v1 } from "googleapis";

export function extractPlainText(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";

  const decode = (data?: string | null) =>
    data ? Buffer.from(data, "base64url").toString("utf-8") : "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }

  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decode(plain.body.data);

    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decode(payload.body.data).replace(/<[^>]+>/g, " ");
  }

  return "";
}

export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}
