import { describe, it, expect, beforeEach } from "vitest";
import {
  InvitationService,
  InMemoryInvitationStore,
  InvitationError,
  DEFAULT_THROTTLE,
  DEFAULT_INVITE_TTL_MS,
  roleAtLeast,
  hashToken,
  type Invitation,
  type InvitationRole,
} from "../src/services/invitationService";

const VAULT = "vault_1";
const OWNER = "G_OWNER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRIBUTOR = "G_CONTRIB_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VIEWER = "G_VIEWER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TARGET = "G_TARGET_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPAMMER_TARGET = "G_TARGET2_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Abuse-resistant invitation workflow (#792): creation, acceptance, expiry,
 * revocation and abuse throttling.
 */
function build(options: { maxActivePerInviter?: number; maxActivePerInvitee?: number; cooldownMs?: number } = {}) {
  const store = new InMemoryInvitationStore();
  let now = 1_700_000_000_000;
  let counter = 0;
  const service = new InvitationService({
    store,
    throttle: {
      maxActivePerInviter: options.maxActivePerInviter ?? DEFAULT_THROTTLE.maxActivePerInviter,
      maxActivePerInvitee: options.maxActivePerInvitee ?? DEFAULT_THROTTLE.maxActivePerInvitee,
      cooldownMs: options.cooldownMs ?? DEFAULT_THROTTLE.cooldownMs,
    },
    now: () => now,
    idFactory: () => `inv_${++counter}`,
    tokenFactory: () => `token_${counter}_${Math.random().toString(36).slice(2)}`,
  });
  return {
    store,
    service,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function expectRejection(promise: Promise<unknown>, code: string, retryAfter?: number) {
  await expect(promise).rejects.toBeInstanceOf(InvitationError);
  const error = await promise.catch((e) => e as InvitationError);
  expect(error.code).toBe(code);
  if (retryAfter !== undefined) expect(error.retryAfterMs).toBe(retryAfter);
}

describe("invitation creation (#792)", () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it("issues a pending invitation with a hashed token", async () => {
    const { invitation, token } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });

    expect(invitation.state).toBe("PENDING");
    // The stored token is a digest, never the raw secret.
    expect(invitation.token).toBe(hashToken(token));
    expect(invitation.token).not.toBe(token);
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("defaults the granted role to the inviter's own role", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: CONTRIBUTOR,
      inviteeId: VIEWER,
      inviterRole: "contributor",
    });
    expect(invitation.role).toBe("contributor");
  });

  it("caps the TTL at the maximum", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      ttlMs: 365 * 24 * 60 * 60 * 1000,
    });
    const ttl = new Date(invitation.expiresAt).getTime() - new Date(invitation.createdAt).getTime();
    expect(ttl).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("uses the default TTL when none is given", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });
    const ttl = new Date(invitation.expiresAt).getTime() - new Date(invitation.createdAt).getTime();
    expect(ttl).toBe(DEFAULT_INVITE_TTL_MS);
  });

  it("rejects a self-invite", async () => {
    await expectRejection(
      harness.service.create({ vaultId: VAULT, inviterId: OWNER, inviteeId: OWNER, inviterRole: "admin" }),
      "SELF_INVITE",
    );
  });

  it("rejects a duplicate outstanding invite", async () => {
    await harness.service.create({ vaultId: VAULT, inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });
    await expectRejection(
      harness.service.create({ vaultId: VAULT, inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" }),
      "DUPLICATE_INVITE",
    );
  });

  it("rejects a malformed request", async () => {
    await expectRejection(
      harness.service.create({ vaultId: "", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" }),
      "INVALID_REQUEST",
    );
  });
});

describe("invitation role validation (#792)", () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it("rejects granting admin by a contributor", async () => {
    await expectRejection(
      harness.service.create({
        vaultId: VAULT,
        inviterId: CONTRIBUTOR,
        inviteeId: VIEWER,
        inviterRole: "contributor",
        role: "admin",
      }),
      "ROLE_ESCALATION",
    );
  });

  it("rejects granting contributor by a viewer", async () => {
    await expectRejection(
      harness.service.create({
        vaultId: VAULT,
        inviterId: VIEWER,
        inviteeId: SPAMMER_TARGET,
        inviterRole: "viewer",
        role: "contributor",
      }),
      "ROLE_ESCALATION",
    );
  });

  it("allows an admin to grant admin", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      role: "admin",
    });
    expect(invitation.role).toBe("admin");
  });

  it("allows granting a lower role", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      role: "viewer",
    });
    expect(invitation.role).toBe("viewer");
  });

  it("orders roles for guard comparisons", () => {
    expect(roleAtLeast("admin", "contributor")).toBe(true);
    expect(roleAtLeast("contributor", "contributor")).toBe(true);
    expect(roleAtLeast("viewer", "contributor")).toBe(false);
  });
});

describe("invitation acceptance (#792)", () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  const issue = (inviteeId = VIEWER, inviterRole: InvitationRole = "admin") =>
    harness.service.create({ vaultId: VAULT, inviterId: OWNER, inviteeId, inviterRole });

  it("accepts a valid invitation and moves it to a terminal state", async () => {
    const { token } = await issue();
    const accepted = await harness.service.accept({ token, inviteeId: VIEWER });

    expect(accepted.state).toBe("ACCEPTED");
    expect(accepted.acceptedAt).toBeTruthy();
  });

  it("rejects an unknown token", async () => {
    await expectRejection(harness.service.accept({ token: "nope", inviteeId: VIEWER }), "NOT_FOUND");
  });

  it("rejects acceptance by a wallet the invite was not addressed to", async () => {
    const { token } = await issue();
    await expectRejection(
      harness.service.accept({ token, inviteeId: SPAMMER_TARGET }),
      "WRONG_INVITEE",
    );
  });

  it("rejects accepting the same invitation twice", async () => {
    const { token } = await issue();
    await harness.service.accept({ token, inviteeId: VIEWER });
    await expectRejection(harness.service.accept({ token, inviteeId: VIEWER }), "ALREADY_ACCEPTED");
  });

  it("leaves an invitation untouched after a rejected acceptance", async () => {
    const { invitation, token } = await issue();
    await expectRejection(harness.service.accept({ token, inviteeId: SPAMMER_TARGET }), "WRONG_INVITEE");

    const stored = await harness.service.get(invitation.id);
    expect(stored?.state).toBe("PENDING");
    expect(stored?.acceptedAt).toBeUndefined();
  });
});

describe("invitation expiry (#792)", () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it("rejects accepting an expired invitation", async () => {
    const { token } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      ttlMs: 1000,
    });

    harness.advance(1500);
    await expectRejection(harness.service.accept({ token, inviteeId: VIEWER }), "EXPIRED");
  });

  it("persists the EXPIRED state when acceptance is refused", async () => {
    const { invitation, token } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      ttlMs: 1000,
    });

    harness.advance(1500);
    await expectRejection(harness.service.accept({ token, inviteeId: VIEWER }), "EXPIRED");

    const stored = await harness.service.get(invitation.id);
    expect(stored?.state).toBe("EXPIRED");
  });

  it("bulk-expires elapsed invitations for an inviter", async () => {
    const first = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      ttlMs: 1000,
    });
    const second = await harness.service.create({
      vaultId: "vault_2",
      inviterId: OWNER,
      inviteeId: SPAMMER_TARGET,
      inviterRole: "admin",
      ttlMs: 5000,
    });

    harness.advance(2000);
    const expired = await harness.service.expireStaleFor(OWNER);

    expect(expired.map((i) => i.id)).toEqual([first.invitation.id]);
    expect((await harness.service.get(second.invitation.id))?.state).toBe("PENDING");
  });
});

describe("invitation revocation (#792)", () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it("revokes a pending invitation", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });

    const revoked = await harness.service.revoke({ invitationId: invitation.id, actorId: OWNER });
    expect(revoked.state).toBe("REVOKED");
    expect(revoked.revokedAt).toBeTruthy();
  });

  it("refuses to accept a revoked invitation", async () => {
    const { invitation, token } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });
    await harness.service.revoke({ invitationId: invitation.id, actorId: OWNER });

    await expectRejection(harness.service.accept({ token, inviteeId: VIEWER }), "REVOKED");
  });

  it("only lets the inviter revoke", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });

    await expectRejection(
      harness.service.revoke({ invitationId: invitation.id, actorId: SPAMMER_TARGET }),
      "WRONG_INVITEE",
    );
    expect((await harness.service.get(invitation.id))?.state).toBe("PENDING");
  });

  it("refuses to revoke twice", async () => {
    const { invitation } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });
    await harness.service.revoke({ invitationId: invitation.id, actorId: OWNER });
    await expectRejection(
      harness.service.revoke({ invitationId: invitation.id, actorId: OWNER }),
      "REVOKED",
    );
  });

  it("refuses to revoke an already accepted invitation", async () => {
    const { invitation, token } = await harness.service.create({
      vaultId: VAULT,
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });
    await harness.service.accept({ token, inviteeId: VIEWER });
    await expectRejection(
      harness.service.revoke({ invitationId: invitation.id, actorId: OWNER }),
      "ALREADY_ACCEPTED",
    );
  });
});

describe("invitation abuse throttling (#792)", () => {
  it("throttles an inviter that sprays invites", async () => {
    const harness = build({ maxActivePerInviter: 2, maxActivePerInvitee: 10, cooldownMs: 0 });
    const targets = [VIEWER, SPAMMER_TARGET, TARGET, OWNER + "_2"];

    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });
    await harness.service.create({ vaultId: "v2", inviterId: OWNER, inviteeId: SPAMMER_TARGET, inviterRole: "admin" });

    await expectRejection(
      harness.service.create({ vaultId: "v3", inviterId: OWNER, inviteeId: TARGET, inviterRole: "admin" }),
      "THROTTLED",
    );
    expect(targets.length).toBeGreaterThan(0);
  });

  it("protects an invitee from too many pending invites", async () => {
    const harness = build({ maxActivePerInviter: 10, maxActivePerInvitee: 1, cooldownMs: 0 });

    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });
    await expectRejection(
      harness.service.create({ vaultId: "v2", inviterId: CONTRIBUTOR, inviteeId: VIEWER, inviterRole: "admin" }),
      "THROTTLED",
    );
  });

  it("enforces a cooldown between invites to the same wallet", async () => {
    const harness = build({ maxActivePerInviter: 10, maxActivePerInvitee: 10, cooldownMs: 60_000 });

    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });
    // Same wallet, different vault, inside the cooldown window.
    await expectRejection(
      harness.service.create({ vaultId: "v2", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" }),
      "THROTTLED",
    );
  });

  it("reports how long to wait when throttled", async () => {
    const harness = build({ maxActivePerInviter: 10, maxActivePerInvitee: 10, cooldownMs: 60_000 });
    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });

    harness.advance(20_000);
    const error = await harness.service
      .create({ vaultId: "v2", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" })
      .catch((e) => e as InvitationError);

    expect(error.code).toBe("THROTTLED");
    expect(error.retryAfterMs).toBe(40_000);
  });

  it("allows inviting again once the cooldown passes", async () => {
    const harness = build({ maxActivePerInviter: 10, maxActivePerInvitee: 10, cooldownMs: 60_000 });
    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });
    harness.advance(61_000);

    const { invitation } = await harness.service.create({
      vaultId: "v2",
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
    });
    expect(invitation.state).toBe("PENDING");
  });

  it("does not count expired invitations against the budget", async () => {
    const harness = build({ maxActivePerInviter: 1, maxActivePerInvitee: 10, cooldownMs: 0 });

    await harness.service.create({
      vaultId: "v1",
      inviterId: OWNER,
      inviteeId: VIEWER,
      inviterRole: "admin",
      ttlMs: 1000,
    });
    harness.advance(2000);

    // The first invite has expired, so the inviter has budget again.
    const { invitation } = await harness.service.create({
      vaultId: "v2",
      inviterId: OWNER,
      inviteeId: SPAMMER_TARGET,
      inviterRole: "admin",
    });
    expect(invitation.state).toBe("PENDING");
  });
});

describe("invitation listing (#792)", () => {
  it("lists invitations for the inviter and the invitee", async () => {
    const harness = build();
    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: VIEWER, inviterRole: "admin" });
    await harness.service.create({ vaultId: "v1", inviterId: OWNER, inviteeId: SPAMMER_TARGET, inviterRole: "admin" });

    const byInviter: Invitation[] = await harness.service.listForInviter(OWNER);
    const byInvitee: Invitation[] = await harness.service.listForInvitee(VIEWER);

    expect(byInviter).toHaveLength(2);
    expect(byInvitee).toHaveLength(1);
    expect(byInvitee[0].inviteeId).toBe(VIEWER);
  });
});
