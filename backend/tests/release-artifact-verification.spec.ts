/**
 * Tests for reproducible release artifact verification (#1087).
 *
 * Coverage:
 * - Normal operation: manifest generation, signing, verification
 * - Failure paths: tampered artifacts, invalid signatures, missing releases
 * - Authorization: signature verification prevents tampering
 * - Recovery: rollback comparison, deployment history
 * - Reproducibility: deterministic hashing and source tree comparison
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  hashString,
  computeSourceTreeHash,
  generateReleaseManifest,
  signManifest,
  verifyManifestSignature,
  ReleaseArtifactVerificationService,
  type BuildEnvironment,
  type ArtifactFile,
} from "../src/services/releaseArtifactVerification.js";

describe("hashString", () => {
  it("generates deterministic SHA-256 hashes", () => {
    const hash1 = hashString("test content");
    const hash2 = hashString("test content");
    
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it("generates different hashes for different content", () => {
    const hash1 = hashString("content A");
    const hash2 = hashString("content B");
    
    expect(hash1).not.toBe(hash2);
  });

  it("is sensitive to small changes", () => {
    const hash1 = hashString("hello");
    const hash2 = hashString("hello!");
    
    expect(hash1).not.toBe(hash2);
  });
});

describe("computeSourceTreeHash", () => {
  it("generates deterministic hash for source files", async () => {
    const files = [
      { path: "src/index.ts", content: "console.log('hello');" },
      { path: "src/utils.ts", content: "export const add = (a, b) => a + b;" },
    ];
    
    const hash1 = await computeSourceTreeHash(files);
    const hash2 = await computeSourceTreeHash(files);
    
    expect(hash1).toBe(hash2);
  });

  it("produces same hash regardless of input order", async () => {
    const files1 = [
      { path: "a.ts", content: "A" },
      { path: "b.ts", content: "B" },
    ];
    
    const files2 = [
      { path: "b.ts", content: "B" },
      { path: "a.ts", content: "A" },
    ];
    
    const hash1 = await computeSourceTreeHash(files1);
    const hash2 = await computeSourceTreeHash(files2);
    
    expect(hash1).toBe(hash2);
  });

  it("detects content changes", async () => {
    const files1 = [{ path: "index.ts", content: "const x = 1;" }];
    const files2 = [{ path: "index.ts", content: "const x = 2;" }];
    
    const hash1 = await computeSourceTreeHash(files1);
    const hash2 = await computeSourceTreeHash(files2);
    
    expect(hash1).not.toBe(hash2);
  });

  it("detects file additions", async () => {
    const files1 = [{ path: "a.ts", content: "A" }];
    const files2 = [
      { path: "a.ts", content: "A" },
      { path: "b.ts", content: "B" },
    ];
    
    const hash1 = await computeSourceTreeHash(files1);
    const hash2 = await computeSourceTreeHash(files2);
    
    expect(hash1).not.toBe(hash2);
  });

  it("detects file removals", async () => {
    const files1 = [
      { path: "a.ts", content: "A" },
      { path: "b.ts", content: "B" },
    ];
    const files2 = [{ path: "a.ts", content: "A" }];
    
    const hash1 = await computeSourceTreeHash(files1);
    const hash2 = await computeSourceTreeHash(files2);
    
    expect(hash1).not.toBe(hash2);
  });
});

describe("generateReleaseManifest", () => {
  const mockBuildEnv: BuildEnvironment = {
    nodeVersion: "20.10.0",
    pnpmVersion: "9.0.0",
    platform: "linux",
    arch: "x64",
    env: { CI: "true", NODE_ENV: "production" },
    buildCommand: "pnpm build",
    buildDuration: 45000,
  };

  const mockArtifacts: ArtifactFile[] = [
    {
      path: "dist/index.js",
      hash: "abc123",
      size: 12345,
      mimeType: "application/javascript",
    },
  ];

  it("generates complete manifest with all required fields", async () => {
    const manifest = await generateReleaseManifest({
      version: "1.0.0",
      commitHash: "abc123def456",
      sourceFiles: [{ path: "src/index.ts", content: "code" }],
      dependencyLockContent: "lock file content",
      artifacts: mockArtifacts,
      buildEnvironment: mockBuildEnv,
    });
    
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.commitHash).toBe("abc123def456");
    expect(manifest.sourceTreeHash).toBeDefined();
    expect(manifest.dependencyLockHash).toBeDefined();
    expect(manifest.artifacts).toEqual(mockArtifacts);
    expect(manifest.buildEnvironment).toEqual(mockBuildEnv);
    expect(manifest.reproducibilityChecks).toBeDefined();
    expect(manifest.reproducibilityChecks.length).toBeGreaterThan(0);
  });

  it("includes reproducibility checks", async () => {
    const manifest = await generateReleaseManifest({
      version: "1.0.0",
      commitHash: "abc123",
      sourceFiles: [],
      dependencyLockContent: "",
      artifacts: [],
      buildEnvironment: mockBuildEnv,
    });
    
    expect(manifest.reproducibilityChecks).toContainEqual(
      expect.objectContaining({
        check: "deterministic_node_modules",
        passed: true,
      })
    );
  });

  it("detects non-CI builds", async () => {
    const nonCIEnv = { ...mockBuildEnv, env: { CI: "false" } };
    
    const manifest = await generateReleaseManifest({
      version: "1.0.0",
      commitHash: "abc123",
      sourceFiles: [],
      dependencyLockContent: "",
      artifacts: [],
      buildEnvironment: nonCIEnv,
    });
    
    const envCheck = manifest.reproducibilityChecks.find(
      (c) => c.check === "environment_isolation"
    );
    
    expect(envCheck?.passed).toBe(false);
  });
});

describe("manifest signing and verification", () => {
  const testSecret = "test-signing-secret";

  it("signs and verifies valid manifest", async () => {
    const manifest = await generateReleaseManifest({
      version: "1.0.0",
      commitHash: "abc123",
      sourceFiles: [],
      dependencyLockContent: "",
      artifacts: [],
      buildEnvironment: {
        nodeVersion: "20.0.0",
        pnpmVersion: "9.0.0",
        platform: "linux",
        arch: "x64",
        env: {},
        buildCommand: "pnpm build",
        buildDuration: 1000,
      },
    });
    
    const signature = signManifest(manifest, testSecret);
    const isValid = verifyManifestSignature(manifest, signature, testSecret);
    
    expect(isValid).toBe(true);
  });

  it("detects tampered manifest", async () => {
    const manifest = await generateReleaseManifest({
      version: "1.0.0",
      commitHash: "abc123",
      sourceFiles: [],
      dependencyLockContent: "",
      artifacts: [],
      buildEnvironment: {
        nodeVersion: "20.0.0",
        pnpmVersion: "9.0.0",
        platform: "linux",
        arch: "x64",
        env: {},
        buildCommand: "pnpm build",
        buildDuration: 1000,
      },
    });
    
    const signature = signManifest(manifest, testSecret);
    
    // Tamper with version
    const tamperedManifest = { ...manifest, version: "2.0.0" };
    const isValid = verifyManifestSignature(tamperedManifest, signature, testSecret);
    
    expect(isValid).toBe(false);
  });

  it("detects wrong signing secret", async () => {
    const manifest = await generateReleaseManifest({
      version: "1.0.0",
      commitHash: "abc123",
      sourceFiles: [],
      dependencyLockContent: "",
      artifacts: [],
      buildEnvironment: {
        nodeVersion: "20.0.0",
        pnpmVersion: "9.0.0",
        platform: "linux",
        arch: "x64",
        env: {},
        buildCommand: "pnpm build",
        buildDuration: 1000,
      },
    });
    
    const signature = signManifest(manifest, testSecret);
    const isValid = verifyManifestSignature(manifest, signature, "wrong-secret");
    
    expect(isValid).toBe(false);
  });
});

describe("ReleaseArtifactVerificationService", () => {
  let mockPrisma: any;
  let service: ReleaseArtifactVerificationService;
  const testSecret = "test-signing-secret";

  beforeEach(() => {
    mockPrisma = {
      releaseArtifact: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      deploymentRecord: {
        create: vi.fn(),
        findMany: vi.fn(),
      },
    };
    
    service = new ReleaseArtifactVerificationService(mockPrisma, testSecret);
  });

  describe("registerRelease", () => {
    it("registers a new release with manifest and signature", async () => {
      const mockRelease = {
        id: "release-123",
        version: "1.0.0",
        commitHash: "abc123",
        buildTimestamp: new Date(),
        buildEnvironment: JSON.stringify({}),
        artifacts: JSON.stringify([]),
        manifest: JSON.stringify({}),
        signature: "sig123",
        verificationStatus: "unverified",
      };
      
      mockPrisma.releaseArtifact.create.mockResolvedValue(mockRelease);
      
      const release = await service.registerRelease({
        version: "1.0.0",
        commitHash: "abc123",
        sourceFiles: [],
        dependencyLockContent: "",
        artifacts: [],
        buildEnvironment: {
          nodeVersion: "20.0.0",
          pnpmVersion: "9.0.0",
          platform: "linux",
          arch: "x64",
          env: {},
          buildCommand: "pnpm build",
          buildDuration: 1000,
        },
      });
      
      expect(release.id).toBe("release-123");
      expect(release.verificationStatus).toBe("unverified");
      expect(mockPrisma.releaseArtifact.create).toHaveBeenCalled();
    });
  });

  describe("verifyRelease", () => {
    it("verifies a valid release", async () => {
      const manifest = await generateReleaseManifest({
        version: "1.0.0",
        commitHash: "abc123",
        sourceFiles: [],
        dependencyLockContent: "",
        artifacts: [],
        buildEnvironment: {
          nodeVersion: "20.0.0",
          pnpmVersion: "9.0.0",
          platform: "linux",
          arch: "x64",
          env: { CI: "true" },
          buildCommand: "pnpm build",
          buildDuration: 1000,
        },
      });
      
      const signature = signManifest(manifest, testSecret);
      
      const mockRelease = {
        id: "release-123",
        version: "1.0.0",
        commitHash: "abc123",
        buildTimestamp: new Date(),
        manifest: JSON.stringify(manifest),
        signature,
        verificationStatus: "unverified",
      };
      
      mockPrisma.releaseArtifact.findUnique.mockResolvedValue(mockRelease);
      mockPrisma.releaseArtifact.update.mockResolvedValue({});
      
      const result = await service.verifyRelease("release-123");
      
      expect(result.valid).toBe(true);
      expect(result.overallStatus).toBe("verified");
      expect(result.checks.find((c) => c.name === "manifest_signature")?.passed).toBe(true);
    });

    it("detects tampered signature", async () => {
      const manifest = await generateReleaseManifest({
        version: "1.0.0",
        commitHash: "abc123",
        sourceFiles: [],
        dependencyLockContent: "",
        artifacts: [],
        buildEnvironment: {
          nodeVersion: "20.0.0",
          pnpmVersion: "9.0.0",
          platform: "linux",
          arch: "x64",
          env: { CI: "false" }, // This will make one check fail
          buildCommand: "pnpm build",
          buildDuration: 1000,
        },
      });
      
      const mockRelease = {
        id: "release-123",
        version: "1.0.0",
        commitHash: "abc123",
        buildTimestamp: new Date(),
        manifest: JSON.stringify(manifest),
        signature: "invalid-signature",
        verificationStatus: "unverified",
      };
      
      mockPrisma.releaseArtifact.findUnique.mockResolvedValue(mockRelease);
      mockPrisma.releaseArtifact.update.mockResolvedValue({});
      
      const result = await service.verifyRelease("release-123");
      
      expect(result.valid).toBe(false);
      // Some checks may pass (commit hash, version) but signature fails
      expect(result.overallStatus).not.toBe("verified");
    });

    it("returns failed status for non-existent release", async () => {
      mockPrisma.releaseArtifact.findUnique.mockResolvedValue(null);
      
      const result = await service.verifyRelease("nonexistent");
      
      expect(result.valid).toBe(false);
      expect(result.checks[0].name).toBe("release_exists");
    });

    it("updates verification status after check", async () => {
      const manifest = await generateReleaseManifest({
        version: "1.0.0",
        commitHash: "abc123",
        sourceFiles: [],
        dependencyLockContent: "",
        artifacts: [],
        buildEnvironment: {
          nodeVersion: "20.0.0",
          pnpmVersion: "9.0.0",
          platform: "linux",
          arch: "x64",
          env: { CI: "true" },
          buildCommand: "pnpm build",
          buildDuration: 1000,
        },
      });
      
      const signature = signManifest(manifest, testSecret);
      
      mockPrisma.releaseArtifact.findUnique.mockResolvedValue({
        id: "release-123",
        version: "1.0.0",
        commitHash: "abc123",
        buildTimestamp: new Date(),
        manifest: JSON.stringify(manifest),
        signature,
        verificationStatus: "unverified",
      });
      mockPrisma.releaseArtifact.update.mockResolvedValue({});
      
      await service.verifyRelease("release-123");
      
      expect(mockPrisma.releaseArtifact.update).toHaveBeenCalledWith({
        where: { id: "release-123" },
        data: { verificationStatus: "verified" },
      });
    });
  });

  describe("getReleaseByVersion", () => {
    it("retrieves release by version", async () => {
      const mockRelease = {
        id: "release-123",
        version: "1.0.0",
        commitHash: "abc123",
        buildTimestamp: new Date(),
        buildEnvironment: JSON.stringify({}),
        artifacts: JSON.stringify([]),
        manifest: JSON.stringify({}),
        signature: "sig123",
        verificationStatus: "verified",
      };
      
      mockPrisma.releaseArtifact.findFirst.mockResolvedValue(mockRelease);
      
      const release = await service.getReleaseByVersion("1.0.0");
      
      expect(release).toBeDefined();
      expect(release?.version).toBe("1.0.0");
    });

    it("returns null for non-existent version", async () => {
      mockPrisma.releaseArtifact.findFirst.mockResolvedValue(null);
      
      const release = await service.getReleaseByVersion("nonexistent");
      
      expect(release).toBeNull();
    });
  });

  describe("listVerifiedReleases", () => {
    it("lists only verified releases", async () => {
      const mockReleases = [
        {
          id: "release-1",
          version: "1.0.1",
          commitHash: "def456",
          buildTimestamp: new Date(),
          buildEnvironment: JSON.stringify({}),
          artifacts: JSON.stringify([]),
          manifest: JSON.stringify({}),
          signature: "sig1",
          verificationStatus: "verified",
        },
        {
          id: "release-2",
          version: "1.0.0",
          commitHash: "abc123",
          buildTimestamp: new Date(),
          buildEnvironment: JSON.stringify({}),
          artifacts: JSON.stringify([]),
          manifest: JSON.stringify({}),
          signature: "sig2",
          verificationStatus: "verified",
        },
      ];
      
      mockPrisma.releaseArtifact.findMany.mockResolvedValue(mockReleases);
      
      const releases = await service.listVerifiedReleases();
      
      expect(releases).toHaveLength(2);
      expect(mockPrisma.releaseArtifact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { verificationStatus: "verified" },
        })
      );
    });
  });

  describe("compareReleases", () => {
    it("identifies differences between releases", async () => {
      const manifest1 = await generateReleaseManifest({
        version: "1.0.0",
        commitHash: "abc123",
        sourceFiles: [{ path: "a.ts", content: "A" }],
        dependencyLockContent: "lock1",
        artifacts: [
          { path: "dist/a.js", hash: "hash1", size: 100, mimeType: "application/javascript" },
        ],
        buildEnvironment: {
          nodeVersion: "20.0.0",
          pnpmVersion: "9.0.0",
          platform: "linux",
          arch: "x64",
          env: {},
          buildCommand: "pnpm build",
          buildDuration: 1000,
        },
      });
      
      const manifest2 = await generateReleaseManifest({
        version: "1.0.1",
        commitHash: "def456",
        sourceFiles: [{ path: "a.ts", content: "B" }], // Changed
        dependencyLockContent: "lock2", // Changed
        artifacts: [
          { path: "dist/a.js", hash: "hash2", size: 110, mimeType: "application/javascript" }, // Modified
          { path: "dist/b.js", hash: "hash3", size: 50, mimeType: "application/javascript" }, // Added
        ],
        buildEnvironment: {
          nodeVersion: "20.0.0",
          pnpmVersion: "9.0.0",
          platform: "linux",
          arch: "x64",
          env: {},
          buildCommand: "pnpm build",
          buildDuration: 1000,
        },
      });
      
      mockPrisma.releaseArtifact.findFirst
        .mockResolvedValueOnce({
          id: "1",
          version: "1.0.0",
          commitHash: "abc123",
          buildTimestamp: new Date(),
          buildEnvironment: "{}",
          artifacts: "[]",
          manifest: JSON.stringify(manifest1),
          signature: "",
          verificationStatus: "verified",
        })
        .mockResolvedValueOnce({
          id: "2",
          version: "1.0.1",
          commitHash: "def456",
          buildTimestamp: new Date(),
          buildEnvironment: "{}",
          artifacts: "[]",
          manifest: JSON.stringify(manifest2),
          signature: "",
          verificationStatus: "verified",
        });
      
      const diff = await service.compareReleases("1.0.0", "1.0.1");
      
      expect(diff.dependencyDiff.hashChanged).toBe(true);
      expect(diff.artifactDiff.added).toContain("dist/b.js");
      expect(diff.artifactDiff.modified).toContain("dist/a.js");
    });
  });

  describe("deployment tracking", () => {
    it("marks release as deployed", async () => {
      mockPrisma.deploymentRecord.create.mockResolvedValue({});
      
      await service.markAsDeployed("release-123", "production");
      
      expect(mockPrisma.deploymentRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          releaseId: "release-123",
          environment: "production",
        }),
      });
    });

    it("retrieves deployment history", async () => {
      const mockDeployments = [
        {
          releaseId: "release-2",
          deployedAt: new Date("2024-01-02"),
          deployedBy: "user2",
          release: { version: "1.0.1" },
        },
        {
          releaseId: "release-1",
          deployedAt: new Date("2024-01-01"),
          deployedBy: "user1",
          release: { version: "1.0.0" },
        },
      ];
      
      mockPrisma.deploymentRecord.findMany.mockResolvedValue(mockDeployments);
      
      const history = await service.getDeploymentHistory("production");
      
      expect(history).toHaveLength(2);
      expect(history[0].version).toBe("1.0.1");
      expect(history[1].version).toBe("1.0.0");
    });
  });
});
