/**
 * Safe handling of untrusted content and external URLs (#774).
 *
 * Shared by the backend (validate/normalize on write) and the frontend
 * (escape/validate on render). Policy per surface:
 *  - plain text fields  -> `sanitizeText` (strip markup + invisible/bidi chars)
 *  - outbound links     -> `sanitizeUrl` (http/https only, no credentials,
 *                          no control chars, optional host allowlist)
 *  - rich text/markdown -> `renderSafeMarkdown` (escape first, then a tiny
 *                          allowlisted inline subset; never emits raw HTML)
 */

// C0/C1 control characters, DEL.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");
// Zero-width, bidi override/isolate, BOM, line/paragraph separators: used to
// disguise text and URLs ("trojan source" style spoofing).
const INVISIBLE_CHARS = new RegExp(
  "[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\u3164\\uFEFF\\uFFA0]",
  "g",
);

export const MAX_URL_LENGTH = 2048;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&#96;/g, "`")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export type SanitizeTextOptions = {
  /** Truncate to this many characters (default 2000). */
  maxLength?: number;
  /** Keep \n and \t (default false: collapse to single spaces). */
  multiline?: boolean;
};

/**
 * Reduces untrusted input to inert plain text: removes script/style blocks and
 * HTML tags/comments, control characters and invisible/bidi characters.
 * Returns "" for non-strings. Output is still escaped by React/`escapeHtml`
 * at render time; this is defence in depth, not a substitute.
 */
export function sanitizeText(input: unknown, options: SanitizeTextOptions = {}): string {
  if (typeof input !== "string") return "";
  const { maxLength = 2000, multiline = false } = options;

  let text = input.normalize("NFC");
  text = text.replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Repeat: "<scr<script>ipt>" must not reassemble into a tag after one pass.
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<\/?[a-zA-Z!?][^>]*>?/g, "");
  } while (text !== previous);

  text = text.replace(INVISIBLE_CHARS, "");
  // Remove (not space-replace) control characters so they can't split words.
  text = text.replace(new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]", "g"), "");
  text = multiline ? text.replace(/[^\S\n\t]+/g, " ") : text.replace(/\s+/g, " ");
  text = text.trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export type SanitizeUrlOptions = {
  /** Allowed protocols (default https/http). Include "mailto:" explicitly if needed. */
  protocols?: readonly string[];
  /** Exact hostnames or parent domains ("example.org" allows "docs.example.org"). */
  allowedHosts?: readonly string[];
  /** Allow root-relative paths like "/app/vaults" (default false). */
  allowRelative?: boolean;
  /** Only allow https (default false). */
  requireHttps?: boolean;
};

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const a = entry.toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  });
}

/**
 * Validates an untrusted URL and returns its normalized form, or `null` when
 * unsafe. Rejects: non-strings, oversize, control/invisible characters (which
 * browsers strip and which enable `java\nscript:` bypasses), protocols outside
 * the allowlist (javascript:, data:, vbscript:, file:, blob: ...), embedded
 * credentials (`https://trusted.com@evil.com`), protocol-relative `//host`,
 * and hosts outside `allowedHosts` when given.
 */
export function sanitizeUrl(input: unknown, options: SanitizeUrlOptions = {}): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  if (new RegExp(CONTROL_CHARS.source).test(raw) || new RegExp(INVISIBLE_CHARS.source).test(raw)) return null;
  if (/[\s\\]/.test(raw)) return null;

  if (raw.startsWith("/")) {
    if (!options.allowRelative || raw.startsWith("//")) return null;
    return raw;
  }

  const protocols = options.requireHttps ? ["https:"] : (options.protocols ?? ["https:", "http:"]);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!protocols.includes(url.protocol)) return null;
  if (url.protocol === "mailto:") return url.href;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  if (options.allowedHosts && !hostAllowed(url.hostname, options.allowedHosts)) return null;
  return url.href;
}

/** `rel` value for every outbound link we render. */
export const SAFE_LINK_REL = "noopener noreferrer nofollow";

export type SafeExternalLink = {
  href: string;
  target: "_blank";
  rel: string;
  /** Host shown to users so the destination is never hidden behind link text. */
  host: string;
};

/** Props for an outbound `<a>`, or `null` if the URL is unsafe (render text only). */
export function toSafeExternalLink(
  input: unknown,
  options: SanitizeUrlOptions = {},
): SafeExternalLink | null {
  const href = sanitizeUrl(input, { ...options, allowRelative: false });
  if (!href) return null;
  return { href, target: "_blank", rel: SAFE_LINK_REL, host: new URL(href).hostname };
}

/**
 * Renders a small markdown subset to safe HTML: `code`, **bold**, *italic*
 * and [text](https-url). All input is escaped before any markup is produced,
 * raw HTML is shown as text, images degrade to their alt text, and links that
 * fail `sanitizeUrl` degrade to plain text.
 */
export function renderSafeMarkdown(markdown: unknown, options: SanitizeUrlOptions = {}): string {
  const source = sanitizeText(markdown, { multiline: true, maxLength: 10_000 });
  // Placeholders use \u0001, which sanitizeText has already stripped from input.
  const stash: string[] = [];
  const hold = (html: string) => `\u0001${stash.push(html) - 1}\u0001`;

  let out = escapeHtml(source);
  out = out.replace(/&#96;((?:(?!&#96;)[^\n])+?)&#96;/g, (_m, code: string) => hold(`<code>${code}</code>`));
  out = out.replace(/!\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, (_m, alt: string) => alt);
  out = out.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, label: string, href: string) => {
    const link = toSafeExternalLink(unescapeHtml(href), options);
    if (!link) return label;
    return hold(
      `<a href="${escapeHtml(link.href)}" target="_blank" rel="${SAFE_LINK_REL}">${label}</a>`,
    );
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/\n/g, "<br>");
  return out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => stash[Number(i)] ?? "");
}
