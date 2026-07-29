import AppNav from "@/components/app/AppNav";
import SystemStatusBanner from "@/components/app/SystemStatusBanner";
import SupportWidget from "@/components/app/SupportWidget";
import Footer from "@/components/app/Footer";

export default function AppLayout({ children }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 pb-24 sm:px-6">
        <SystemStatusBanner />
        {children}
      </main>
      <Footer />
      <SupportWidget />
    </div>
  );
}
