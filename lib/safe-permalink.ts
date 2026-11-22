export type PublicRecordState = "active" | "archived" | "restricted" | "deleted";

export type PublicPermalinkRecord = {
  id: string;
  slug: string;
  previousSlugs?: string[];
  state: PublicRecordState;
};

export type PermalinkResolution =
  | { kind: "canonical"; href: string }
  | { kind: "redirect"; href: string; permanent: true }
  | { kind: "not-found" }
  | { kind: "forbidden" };

/** Resolve a public record without exposing restricted/deleted record state. */
export function resolvePublicPermalink(
  record: PublicPermalinkRecord | null,
  requestedSlug: string,
  basePath = "/vaults",
): PermalinkResolution {
  if (!record || record.state === "deleted") return { kind: "not-found" };
  if (record.state === "restricted") return { kind: "forbidden" };
  const href = `${basePath}/${encodeURIComponent(record.id)}/${encodeURIComponent(record.slug)}`;
  if (requestedSlug === record.slug) return { kind: "canonical", href };
  if (record.previousSlugs?.includes(requestedSlug)) return { kind: "redirect", href, permanent: true };
  return { kind: "not-found" };
}
