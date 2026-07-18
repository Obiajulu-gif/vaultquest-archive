import "@/styles/globals.css";
import Providers from "@/components/providers/Providers";

export const metadata = {
  title: "VaultQuest — No-loss prize savings",
  description: "Deposit, earn yield, and win prizes without risking your principal.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("vaultquest-high-contrast")==="true"){document.documentElement.classList.add("high-contrast")}}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
