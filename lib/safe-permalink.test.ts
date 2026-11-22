import { describe, expect, it } from "vitest";
import { resolvePublicPermalink } from "./safe-permalink";

const record = { id: "vault-1", slug: "new-name", previousSlugs: ["old-name"], state: "active" as const };

describe("resolvePublicPermalink", () => {
  it("redirects renamed records to the canonical URL", () => {
    expect(resolvePublicPermalink(record, "old-name")).toEqual({ kind: "redirect", href: "/vaults/vault-1/new-name", permanent: true });
  });
  it("does not disclose deleted or restricted records", () => {
    expect(resolvePublicPermalink({ ...record, state: "deleted" }, "old-name")).toEqual({ kind: "not-found" });
    expect(resolvePublicPermalink({ ...record, state: "restricted" }, "old-name")).toEqual({ kind: "forbidden" });
  });
});
