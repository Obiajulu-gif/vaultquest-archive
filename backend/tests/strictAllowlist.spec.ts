import { describe, it, expect } from "vitest";
import {
  validateUrl,
  validateFileType,
  validateDestination,
  DEFAULT_URL_POLICY,
  DEFAULT_FILE_TYPE_POLICY,
  type UrlPolicy,
  type FileTypePolicy,
  type DestinationTarget
} from "../src/services/strictAllowlistService.js";
import { ERROR_CODES } from "../src/constants.js";

describe("Strict Allow-List Validation (#990)", () => {
  describe("1. URL Allow-List Validation", () => {
    it("admits valid HTTPS URLs matching allowlisted domains and wildcards", () => {
      const res1 = validateUrl("https://horizon-testnet.stellar.org/accounts");
      expect(res1.allowed).toBe(true);
      if (res1.allowed) {
        expect(res1.url.hostname).toBe("horizon-testnet.stellar.org");
      }

      const res2 = validateUrl("https://api.vaultquest.app/v1/pools");
      expect(res2.allowed).toBe(true);

      const res3 = validateUrl("https://stellar.org");
      expect(res3.allowed).toBe(true);
    });

    it("rejects non-HTTPS schemes by default", () => {
      const httpRes = validateUrl("http://stellar.org");
      expect(httpRes.allowed).toBe(false);
      if (!httpRes.allowed) {
        expect(httpRes.code).toBe(ERROR_CODES.URL_NOT_ALLOWED);
        expect(httpRes.reason).toContain("Scheme 'http:' is not allowed");
      }

      const ftpRes = validateUrl("ftp://stellar.org/file");
      expect(ftpRes.allowed).toBe(false);

      const jsRes = validateUrl("javascript:alert(1)");
      expect(jsRes.allowed).toBe(false);

      const fileRes = validateUrl("file:///etc/passwd");
      expect(fileRes.allowed).toBe(false);
    });

    it("rejects URLs with embedded credentials", () => {
      const res = validateUrl("https://admin:secret@stellar.org");
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("Embedded URL credentials are not allowed");
      }
    });

    it("rejects unauthorized ports", () => {
      const res = validateUrl("https://stellar.org:8080/path");
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("Port 8080 is not allowed");
      }
    });

    it("rejects IP literals and cloud metadata SSRF vectors", () => {
      // AWS/GCP metadata service
      const metaRes = validateUrl("https://169.254.169.254/latest/meta-data");
      expect(metaRes.allowed).toBe(false);
      if (!metaRes.allowed) {
        expect(metaRes.reason).toContain("Private or metadata IP literals are strictly forbidden");
      }

      // Local loopback
      const loopRes = validateUrl("https://127.0.0.1:443");
      expect(loopRes.allowed).toBe(false);

      // Private RFC 1918
      const privRes = validateUrl("https://10.0.0.1:443");
      expect(privRes.allowed).toBe(false);

      // IPv6 literal
      const v6Res = validateUrl("https://[::1]:443");
      expect(v6Res.allowed).toBe(false);
    });

    it("rejects localhost unless explicitly configured for testing", () => {
      const defaultRes = validateUrl("https://localhost:443");
      expect(defaultRes.allowed).toBe(false);

      const testPolicy: UrlPolicy = {
        allowedHosts: ["localhost"],
        allowedSchemes: ["https:", "http:"],
        allowedPorts: [80, 443, 3000],
        allowLocalhost: true
      };
      const testRes = validateUrl("http://localhost:3000/callback", testPolicy);
      expect(testRes.allowed).toBe(true);
    });

    it("rejects non-allowlisted third-party hosts", () => {
      const res = validateUrl("https://malicious-attacker.com/webhook");
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("not in the allow-list");
      }
    });

    it("fails closed when allowlist is empty", () => {
      const res = validateUrl("https://stellar.org", { allowedHosts: [] });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("allow-list is empty");
      }
    });
  });

  describe("2. File Type & Extension Allow-List Validation", () => {
    it("admits valid CSV and JSON filenames and MIME types", () => {
      const csvRes = validateFileType("transactions_2026.csv", "text/csv");
      expect(csvRes.allowed).toBe(true);
      if (csvRes.allowed) {
        expect(csvRes.extension).toBe(".csv");
        expect(csvRes.mimeType).toBe("text/csv");
      }

      const jsonRes = validateFileType("vault_export.json", "application/json");
      expect(jsonRes.allowed).toBe(true);
      if (jsonRes.allowed) {
        expect(jsonRes.extension).toBe(".json");
        expect(jsonRes.mimeType).toBe("application/json");
      }
    });

    it("rejects dangerous executable and script extensions", () => {
      const dangerous = ["payload.exe", "script.sh", "code.py", "exploit.php", "vector.svg", "page.html", "archive.zip"];
      for (const name of dangerous) {
        const res = validateFileType(name);
        expect(res.allowed).toBe(false);
        if (!res.allowed) {
          expect(res.code).toBe(ERROR_CODES.FILE_TYPE_NOT_ALLOWED);
        }
      }
    });

    it("detects and rejects double extensions and obfuscated files", () => {
      const res1 = validateFileType("report.csv.exe");
      expect(res1.allowed).toBe(false);

      const res2 = validateFileType("data.json.html");
      expect(res2.allowed).toBe(false);

      const res3 = validateFileType("export.exe.csv");
      expect(res3.allowed).toBe(false);
      if (!res3.allowed) {
        expect(res3.reason).toContain("Nested dangerous extension");
      }
    });

    it("detects and rejects path traversal attempts in filenames", () => {
      const res1 = validateFileType("../../etc/passwd.json");
      expect(res1.allowed).toBe(false);
      if (!res1.allowed) {
        expect(res1.reason).toContain("Path traversal");
      }

      const res2 = validateFileType("..\\windows\\system32.csv");
      expect(res2.allowed).toBe(false);
    });

    it("detects and rejects null byte injections", () => {
      const res1 = validateFileType("legit.csv\0.exe");
      expect(res1.allowed).toBe(false);
      if (!res1.allowed) {
        expect(res1.reason).toContain("null bytes");
      }

      const res2 = validateFileType("legit.csv%00.exe");
      expect(res2.allowed).toBe(false);
    });

    it("rejects MIME type mismatches", () => {
      const res = validateFileType("export.json", "text/csv");
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("does not match expected types");
      }
    });

    it("enforces maximum filename length", () => {
      const longName = `${"a".repeat(150)}.json`;
      const res = validateFileType(longName);
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("exceeds maximum length");
      }
    });
  });

  describe("3. Destination Allow-List Validation", () => {
    it("admits valid Stellar wallet destination addresses", () => {
      const validGAddress = "GDIMOLUISHWJPMA2OJVIV5567AEKHBGUE3BFMFCQEWTIJMST2G35K7AX";
      const res = validateDestination({ type: "wallet", target: validGAddress });
      expect(res.allowed).toBe(true);
      if (res.allowed) {
        expect(res.destination.target).toBe(validGAddress);
      }

      // Also admits valid Soroban contract address destination
      const validContract = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
      const contractRes = validateDestination({ type: "wallet", target: validContract });
      expect(contractRes.allowed).toBe(true);
    });

    it("rejects invalid Stellar wallet destination addresses", () => {
      const invalidGAddress = "0x1234567890abcdef1234567890abcdef12345678";
      const res = validateDestination({ type: "wallet", target: invalidGAddress });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe(ERROR_CODES.DESTINATION_NOT_ALLOWED);
        expect(res.reason).toContain("Invalid Stellar wallet destination");
      }
    });

    it("validates webhook destinations against URL allowlist", () => {
      const validRes = validateDestination({ type: "webhook", target: "https://horizon.stellar.org/webhook" });
      expect(validRes.allowed).toBe(true);

      const invalidRes = validateDestination({ type: "webhook", target: "https://evil.com/leak" });
      expect(invalidRes.allowed).toBe(false);
      if (!invalidRes.allowed) {
        expect(invalidRes.reason).toContain("Webhook destination rejected");
      }
    });

    it("validates download filenames against file type allowlist", () => {
      const validRes = validateDestination({ type: "download", target: "activity-export.json" });
      expect(validRes.allowed).toBe(true);

      const invalidRes = validateDestination({ type: "download", target: "bad-script.sh" });
      expect(invalidRes.allowed).toBe(false);
      if (!invalidRes.allowed) {
        expect(invalidRes.reason).toContain("Download filename rejected");
      }
    });

    it("validates notification channels against allowed list", () => {
      const validRes = validateDestination({ type: "notification_channel", target: "in_app" });
      expect(validRes.allowed).toBe(true);

      const invalidRes = validateDestination({ type: "notification_channel", target: "unsupported_sms" });
      expect(invalidRes.allowed).toBe(false);
      if (!invalidRes.allowed) {
        expect(invalidRes.reason).toContain("Notification channel 'unsupported_sms' is not allowed");
      }
    });

    it("rejects disallowed destination types", () => {
      const res = validateDestination(
        { type: "webhook", target: "https://stellar.org" },
        { allowedTypes: ["wallet"] }
      );
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.reason).toContain("Destination type 'webhook' is not allowed");
      }
    });
  });

  describe("4. Dynamic Policy Updates & Recovery", () => {
    it("allows dynamic policy extension without server restart", () => {
      const initialUrl = "https://partner-service.io/callback";
      expect(validateUrl(initialUrl).allowed).toBe(false);

      const extendedPolicy: UrlPolicy = {
        ...DEFAULT_URL_POLICY,
        allowedHosts: [...DEFAULT_URL_POLICY.allowedHosts, "partner-service.io"]
      };

      const retryRes = validateUrl(initialUrl, extendedPolicy);
      expect(retryRes.allowed).toBe(true);
    });

    it("maintains idempotent validation on repeated executions", () => {
      const url = "https://horizon-testnet.stellar.org";
      for (let i = 0; i < 5; i++) {
        const res = validateUrl(url);
        expect(res.allowed).toBe(true);
      }
    });
  });
});
