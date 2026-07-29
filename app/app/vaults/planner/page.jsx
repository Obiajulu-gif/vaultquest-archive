"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { 
  ChevronLeft, 
  Calendar, 
  Clock, 
  Trash2, 
  AlertCircle, 
  CheckCircle2, 
  Plus, 
  DollarSign, 
  Wallet,
  Sparkles
} from "lucide-react";
import { MOCK_VAULTS } from "@/components/app/VaultList";

const FREQUENCIES = [
  { id: "daily", name: "Daily" },
  { id: "weekly", name: "Weekly" },
  { id: "biweekly", name: "Bi-weekly" },
  { id: "monthly", name: "Monthly" }
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function DepositPlannerPage() {
  const { isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);

  // Form State
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [selectedDay, setSelectedDay] = useState(1); // Monday for weekly, day of month for monthly

  // App States
  const [schedules, setSchedules] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Prevent NextJS Hydration mismatches
  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("vaultquest_deposit_schedules");
    if (stored) {
      try {
        setSchedules(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse schedules from storage", e);
      }
    }
  }, []);

  const saveSchedules = (newSchedules) => {
    setSchedules(newSchedules);
    localStorage.setItem("vaultquest_deposit_schedules", JSON.stringify(newSchedules));
  };

  const selectedVault = useMemo(() => {
    return MOCK_VAULTS.find((v) => String(v.id) === selectedVaultId) || null;
  }, [selectedVaultId]);

  // Dynamically calculate the next planned action date based on frequency and day selected
  const nextPlannedAction = useMemo(() => {
    if (!selectedVault || !amount || parseFloat(amount) <= 0) return null;

    const now = new Date();
    let nextDate = new Date();

    if (frequency === "daily") {
      nextDate.setDate(now.getDate() + 1);
      nextDate.setHours(9, 0, 0, 0); // Default to 9:00 AM
    } else if (frequency === "weekly" || frequency === "biweekly") {
      const targetDay = parseInt(selectedDay); // 0 = Sun, 1 = Mon, etc.
      const currentDay = now.getDay();
      let diff = targetDay - currentDay;
      if (diff <= 0) {
        diff += 7; // Next week's occurrence
      }
      
      if (frequency === "biweekly") {
        nextDate.setDate(now.getDate() + diff + 7);
      } else {
        nextDate.setDate(now.getDate() + diff);
      }
      nextDate.setHours(9, 0, 0, 0);
    } else if (frequency === "monthly") {
      const targetDayOfMonth = parseInt(selectedDay);
      const currentDayOfMonth = now.getDate();
      
      if (currentDayOfMonth < targetDayOfMonth) {
        nextDate.setDate(targetDayOfMonth);
      } else {
        nextDate.setMonth(now.getMonth() + 1);
        nextDate.setDate(targetDayOfMonth);
      }
      nextDate.setHours(9, 0, 0, 0);
    }

    return {
      date: nextDate,
      formattedDate: nextDate.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      actionText: `Deposit ${parseFloat(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${selectedVault.asset} to ${selectedVault.name}`
    };
  }, [selectedVault, amount, frequency, selectedDay]);

  const handleAddSchedule = (e) => {
    e.preventDefault();
    setErrorMsg("");
    setSuccessMsg("");

    if (!isConnected) {
      setErrorMsg("Wallet connection required to configure automated deposit triggers.");
      return;
    }

    if (!selectedVaultId) {
      setErrorMsg("Please select a target vault.");
      return;
    }

    const amtFloat = parseFloat(amount);
    if (isNaN(amtFloat) || amtFloat <= 0) {
      setErrorMsg("Please enter a valid deposit amount greater than zero.");
      return;
    }

    const newSchedule = {
      id: Math.random().toString(36).substr(2, 9),
      vaultId: selectedVault.id,
      vaultName: selectedVault.name,
      asset: selectedVault.asset,
      network: selectedVault.network,
      amount: amtFloat,
      frequency,
      dayPreference: selectedDay,
      nextActionDate: nextPlannedAction.formattedDate,
      createdAt: new Date().toISOString()
    };

    const updated = [newSchedule, ...schedules];
    saveSchedules(updated);
    
    // Clear form
    setAmount("");
    setSelectedVaultId("");
    setSuccessMsg("Deposit schedule created successfully!");
    
    setTimeout(() => {
      setSuccessMsg("");
    }, 4000);
  };

  const handleDeleteSchedule = (id) => {
    const updated = schedules.filter((s) => s.id !== id);
    saveSchedules(updated);
  };

  if (!mounted) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-6 w-24 bg-vault-border/20 rounded" />
        <div className="h-10 w-2/3 bg-vault-border/30 rounded-xl" />
        <div className="h-40 bg-vault-border/10 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Navigation Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-vault-muted">
          <Link href="/app/vaults" className="hover:text-vault-text transition-colors">
            Vaults
          </Link>
          <span>/</span>
          <span className="text-vault-text font-medium">Schedule Planner</span>
        </div>
        <Link href="/app/vaults" className="vq-btn-ghost py-1.5 px-3 self-start flex items-center gap-1">
          <ChevronLeft size={16} /> Back to Vaults
        </Link>
      </div>

      <header className="space-y-3">
        <h1 className="text-3xl font-extrabold text-vault-text sm:text-4xl">Deposit Schedule Planner</h1>
        <p className="max-w-2xl text-vault-muted leading-relaxed">
          Set up recurring deposit goals to automatically compound your savings pools and maximize your prize draw tickets.
        </p>
      </header>

      {/* Main Layout Grid */}
      <div className="grid gap-8 lg:grid-cols-12">
        {/* Left Column: Schedule Creator Form */}
        <section className="space-y-6 lg:col-span-7">
          <div className="vq-glass p-6 sm:p-8 space-y-6">
            <h2 className="text-xl font-bold text-vault-text flex items-center gap-2">
              <Plus className="h-5 w-5 text-red-500" /> Configure New Schedule
            </h2>

            {!isConnected && (
              <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 text-red-500 flex items-start gap-3">
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <span className="font-bold">Wallet Disconnected:</span> You must connect your Web3 wallet to authorize smart scheduler transaction signatures.
                </div>
              </div>
            )}

            <form onSubmit={handleAddSchedule} className="space-y-5">
              {/* Select Vault */}
              <div className="space-y-2">
                <label htmlFor="vault-select" className="text-sm font-semibold text-vault-text">
                  Target Vault
                </label>
                <select
                  id="vault-select"
                  value={selectedVaultId}
                  onChange={(e) => setSelectedVaultId(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                >
                  <option value="">Select a vault...</option>
                  {MOCK_VAULTS.map((vault) => (
                    <option key={vault.id} value={vault.id}>
                      {vault.name} ({vault.asset} on {vault.network})
                    </option>
                  ))}
                </select>
              </div>

              {/* Amount Input */}
              <div className="space-y-2">
                <label htmlFor="schedule-amount" className="text-sm font-semibold text-vault-text">
                  Recurring Amount
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-3 text-sm font-semibold text-vault-muted">
                    <DollarSign size={16} />
                  </span>
                  <input
                    id="schedule-amount"
                    type="number"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full pl-9 pr-16 py-2.5 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                    placeholder="100.00"
                  />
                  {selectedVault && (
                    <span className="absolute right-4 top-3 text-xs font-bold text-vault-muted uppercase">
                      {selectedVault.asset}
                    </span>
                  )}
                </div>
              </div>

              {/* Frequency Selection */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="frequency-select" className="text-sm font-semibold text-vault-text">
                    Frequency
                  </label>
                  <select
                    id="frequency-select"
                    value={frequency}
                    onChange={(e) => {
                      setFrequency(e.target.value);
                      setSelectedDay(e.target.value === "monthly" ? 1 : 1); // Reset defaults
                    }}
                    className="w-full px-4 py-2.5 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>

                {frequency !== "daily" && (
                  <div className="space-y-2">
                    <label htmlFor="day-preference-select" className="text-sm font-semibold text-vault-text">
                      {frequency === "monthly" ? "Day of Month" : "Day of Week"}
                    </label>
                    <select
                      id="day-preference-select"
                      value={selectedDay}
                      onChange={(e) => setSelectedDay(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                    >
                      {frequency === "monthly"
                        ? Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                            <option key={day} value={day}>
                              Day {day}
                            </option>
                          ))
                        : WEEKDAYS.map((dayName, idx) => (
                            <option key={idx} value={idx}>
                              {dayName}
                            </option>
                          ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Next Planned Action Calculator Panel */}
              {nextPlannedAction && (
                <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                    <Sparkles size={14} /> Live Next Action Projection
                  </div>
                  <div className="text-sm text-vault-text font-bold">
                    {nextPlannedAction.actionText}
                  </div>
                  <div className="text-xs text-vault-muted flex items-center gap-1">
                    <Calendar size={12} /> Scheduled for {nextPlannedAction.formattedDate} at 9:00 AM
                  </div>
                </div>
              )}

              {/* Form Statuses */}
              {errorMsg && (
                <div className="text-sm text-red-500 flex items-center gap-1.5">
                  <AlertCircle size={16} /> {errorMsg}
                </div>
              )}
              {successMsg && (
                <div className="text-sm text-emerald-500 flex items-center gap-1.5">
                  <CheckCircle2 size={16} /> {successMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={!isConnected}
                className={`vq-btn-primary w-full ${!isConnected ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <Plus size={16} /> Add Schedule
              </button>
            </form>
          </div>
        </section>

        {/* Right Column: Existing Schedules / Empty State */}
        <section className="space-y-6 lg:col-span-5">
          <div className="vq-glass p-6 sm:p-8 space-y-6">
            <h2 className="text-xl font-bold text-vault-text flex items-center gap-2">
              <Calendar className="h-5 w-5 text-red-500" /> Active Schedules
            </h2>

            {schedules.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center text-center space-y-3">
                <div className="h-12 w-12 rounded-full border border-vault-border flex items-center justify-center text-vault-muted bg-vault-surface">
                  <Clock size={20} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-vault-text">No active schedules</h3>
                  <p className="text-xs text-vault-muted max-w-[240px]">
                    Setup recurring deposits on the left to systematically build your tickets.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {schedules.map((schedule) => (
                  <div 
                    key={schedule.id}
                    className="p-4 rounded-xl border border-vault-border bg-vault-surface/40 flex items-start justify-between gap-3 hover:border-red-400/25 transition-all"
                  >
                    <div className="space-y-1">
                      <h4 className="text-sm font-bold text-vault-text">{schedule.vaultName}</h4>
                      <p className="text-xs text-vault-muted">
                        Amount: <span className="font-semibold text-vault-text">{schedule.amount.toLocaleString()} {schedule.asset}</span>
                      </p>
                      <p className="text-[10px] text-red-500/80 font-bold uppercase tracking-wider">
                        Frequency: {schedule.frequency}
                      </p>
                      <div className="flex items-center gap-1 text-[10px] text-vault-muted pt-1">
                        <Calendar size={10} /> Next Action: {schedule.nextActionDate}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteSchedule(schedule.id)}
                      className="p-1.5 rounded-lg text-vault-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="Delete schedule"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="flex justify-center pt-4">
        <Link href="/app/vaults" className="vq-btn-ghost">
          ← Return to Vaults List
        </Link>
      </div>
    </div>
  );
}
