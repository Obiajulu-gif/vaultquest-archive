import AppNav from "@/components/app/AppNav";
import Sidebar from "@/components/app/Sidebar";
import SystemStatusBanner from "@/components/app/SystemStatusBanner";
import SupportWidget from "@/components/app/SupportWidget";
import Footer from "@/components/app/Footer";

export default function AppLayout({ children }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppNav />
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex-1 px-4 py-8 pb-24 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SystemStatusBanner />
            {children}
          </div>
        </main>
      </div>
      <Footer />
      <SupportWidget />
    </div>
  );
}
