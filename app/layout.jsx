import "@/styles/globals.css";
import Providers from "@/components/providers/Providers";
import AttestationProvider from "@/components/AttestationProvider";
import { Toaster } from "react-hot-toast";
import { readFileSync } from "fs";
import { resolve } from "path";

let manifestVersion = "";
let manifestEnvironment = "";
try {
  const manifestPath = resolve(process.cwd(), "deployment-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifestVersion = manifest.version || "";
  manifestEnvironment = manifest.environment || "";
} catch {
  // Manifest not available at build time
}

export const metadata = {
  title: "VaultQuest — No-loss prize savings",
  description: "Deposit, earn yield, and win prizes without risking your principal.",
  other: {
    "deployment-version": manifestVersion,
    "deployment-environment": manifestEnvironment,
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("vaultquest-theme");if(t==="system"||!t){var d=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;"dark"===d?document.documentElement.classList.add("dark"):"light"===d&&document.documentElement.classList.remove("dark")}else if(t==="dark"){document.documentElement.classList.add("dark")}else{document.documentElement.classList.remove("dark")}if(localStorage.getItem("vaultquest-high-contrast")==="true"){document.documentElement.classList.add("high-contrast")}}catch(e){}})();`,
          }}
        />
        {manifestVersion && (
          <meta name="deployment-version" content={manifestVersion} />
        )}
      </head>
      <body>
        <AttestationProvider>
          <Providers>{children}</Providers>
        </AttestationProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
