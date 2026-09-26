"use client";

import { useState, useCallback, useMemo } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Wallet,
} from "lucide-react";
import { toast } from "react-hot-toast";

const ASSETS = ["XLM", "USDC", "USDT", "BTC"];
const LOCKUP_OPTIONS = [
  { label: "Flexible (no lock)", value: 0 },
  { label: "1–7 days", value: 7 },
  { label: "8–14 days", value: 14 },
  { label: "15+ days", value: 90 },
];

const VALIDATION = {
  name: { minLength: 3, maxLength: 64 },
  minDeposit: { min: 1, max: 100_000 },
  maxDeposit: { min: 10, max: 1_000_000 },
  maxParticipants: { min: 1, max: 10_000 },
};

function validateForm(form) {
  const errors = {};

  if (!form.name || form.name.trim().length < VALIDATION.name.minLength) {
    errors.name = `Pool name must be at least ${VALIDATION.name.minLength} characters.`;
  }
  if (form.name && form.name.length > VALIDATION.name.maxLength) {
    errors.name = `Pool name must be at most ${VALIDATION.name.maxLength} characters.`;
  }

  const minDep = parseFloat(form.minDeposit);
  if (!form.minDeposit || isNaN(minDep) || minDep < VALIDATION.minDeposit.min) {
    errors.minDeposit = `Minimum deposit must be at least ${VALIDATION.minDeposit.min}.`;
  }
  if (minDep > VALIDATION.minDeposit.max) {
    errors.minDeposit = `Minimum deposit cannot exceed ${VALIDATION.minDeposit.max.toLocaleString()}.`;
  }

  const maxDep = parseFloat(form.maxDeposit);
  if (!form.maxDeposit || isNaN(maxDep) || maxDep < VALIDATION.maxDeposit.min) {
    errors.maxDeposit = `Maximum deposit must be at least ${VALIDATION.maxDeposit.min}.`;
  }
  if (maxDep > VALIDATION.maxDeposit.max) {
    errors.maxDeposit = `Maximum deposit cannot exceed ${VALIDATION.maxDeposit.max.toLocaleString()}.`;
  }

  if (!isNaN(minDep) && !isNaN(maxDep) && minDep >= maxDep) {
    errors.maxDeposit = "Maximum deposit must be greater than the minimum.";
  }

  const maxPart = parseInt(form.maxParticipants, 10);
  if (!form.maxParticipants || isNaN(maxPart) || maxPart < VALIDATION.maxParticipants.min) {
    errors.maxParticipants = "Maximum participants must be at least 1.";
  }
  if (maxPart > VALIDATION.maxParticipants.max) {
    errors.maxParticipants = `Maximum participants cannot exceed ${VALIDATION.maxParticipants.max.toLocaleString()}.`;
  }

  if (!form.startDate) {
    errors.startDate = "Start date is required.";
  }
  if (!form.endDate) {
    errors.endDate = "End date is required.";
  }
  if (form.startDate && form.endDate && form.startDate >= form.endDate) {
    errors.endDate = "End date must be after the start date.";
  }

  return errors;
}

function FieldError({ message }) {
  if (!message) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-red-500" role="alert">
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

function StepIndicator({ current, total }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i <= current ? "bg-red-500 w-6" : "bg-vault-border w-1.5"
          }`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

export default function PoolCreationForm({ onSubmit }) {
  const [step, setStep] = useState(0); // 0=form, 1=review, 2=submitting, 3=success
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState({
    name: "",
    asset: "XLM",
    minDeposit: "100",
    maxDeposit: "250000",
    maxParticipants: "1000",
    startDate: "",
    endDate: "",
    lockup: 0,
    rewardYieldPct: "100",
    description: "",
  });

  const update = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }, []);

  const fieldError = useMemo(() => (field) => errors[field] || null, [errors]);
  const hasErrors = Object.keys(errors).length > 0;

  const handleNext = useCallback(() => {
    const errs = validateForm(form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setStep(1);
  }, [form]);

  const handleSubmit = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setStep(2);
    try {
      await onSubmit?.(form);
      setStep(3);
      toast.success("Pool created successfully!", { duration: 5000 });
    } catch {
      toast.error("Failed to create pool. Please try again.");
      setStep(1);
    } finally {
      setPending(false);
    }
  }, [form, onSubmit, pending]);

  return (
    <div className="vq-glass mx-auto max-w-3xl p-5 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-vault-muted">
            Pool creation
          </p>
          <h2 className="mt-1 text-xl font-semibold text-vault-text">
            {step === 0
              ? "Configure pool parameters"
              : step === 1
                ? "Review before submission"
                : step === 2
                  ? "Submitting..."
                  : "Pool created"}
          </h2>
        </div>
        <StepIndicator current={step} total={3} />
      </div>

      {/* Step 0: Form */}
      {step === 0 && (
        <div className="space-y-5">
          {/* Pool name */}
          <div>
            <label htmlFor="pool-name" className="block text-sm font-medium text-vault-text">
              Pool name *
            </label>
            <input
              id="pool-name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              placeholder="e.g. USDC Stable Yield Pool"
              maxLength={VALIDATION.name.maxLength}
            />
            <FieldError message={fieldError("name")} />
          </div>

          {/* Asset + Lockup row */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pool-asset" className="block text-sm font-medium text-vault-text">
                Asset
              </label>
              <select
                id="pool-asset"
                value={form.asset}
                onChange={(e) => update("asset", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              >
                {ASSETS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pool-lockup" className="block text-sm font-medium text-vault-text">
                Default lockup
              </label>
              <select
                id="pool-lockup"
                value={form.lockup}
                onChange={(e) => update("lockup", Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              >
                {LOCKUP_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Deposit limits row */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pool-min" className="block text-sm font-medium text-vault-text">
                Minimum deposit ({form.asset})
              </label>
              <input
                id="pool-min"
                type="number"
                min={VALIDATION.minDeposit.min}
                value={form.minDeposit}
                onChange={(e) => update("minDeposit", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              />
              <FieldError message={fieldError("minDeposit")} />
            </div>
            <div>
              <label htmlFor="pool-max" className="block text-sm font-medium text-vault-text">
                Maximum deposit ({form.asset})
              </label>
              <input
                id="pool-max"
                type="number"
                min={VALIDATION.maxDeposit.min}
                value={form.maxDeposit}
                onChange={(e) => update("maxDeposit", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              />
              <FieldError message={fieldError("maxDeposit")} />
            </div>
          </div>

          {/* Participants + Yield row */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pool-participants" className="block text-sm font-medium text-vault-text">
                Maximum participants
              </label>
              <input
                id="pool-participants"
                type="number"
                min={VALIDATION.maxParticipants.min}
                max={VALIDATION.maxParticipants.max}
                value={form.maxParticipants}
                onChange={(e) => update("maxParticipants", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              />
              <FieldError message={fieldError("maxParticipants")} />
            </div>
            <div>
              <label htmlFor="pool-yield" className="block text-sm font-medium text-vault-text">
                Reward yield (bps)
              </label>
              <input
                id="pool-yield"
                type="number"
                min={0}
                max={500}
                value={form.rewardYieldPct}
                onChange={(e) => update("rewardYieldPct", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              />
              <p className="mt-1 text-xs text-vault-muted">100 bps = 1x baseline reward weight</p>
            </div>
          </div>

          {/* Dates row */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pool-start" className="block text-sm font-medium text-vault-text">
                Start date *
              </label>
              <input
                id="pool-start"
                type="date"
                value={form.startDate}
                onChange={(e) => update("startDate", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              />
              <FieldError message={fieldError("startDate")} />
            </div>
            <div>
              <label htmlFor="pool-end" className="block text-sm font-medium text-vault-text">
                End date *
              </label>
              <input
                id="pool-end"
                type="date"
                value={form.endDate}
                onChange={(e) => update("endDate", e.target.value)}
                className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25"
              />
              <FieldError message={fieldError("endDate")} />
            </div>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="pool-desc" className="block text-sm font-medium text-vault-text">
              Description (optional)
            </label>
            <textarea
              id="pool-desc"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm text-vault-text outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/25 resize-none"
              placeholder="Brief description of this pool's purpose..."
            />
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-vault-muted">
              {hasErrors ? "Please fix the errors above to continue." : "Review all values before proceeding."}
            </p>
            <button type="button" onClick={handleNext} className="vq-btn-primary">
              Review <ArrowRight className="h-4 w-4 ml-1" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* Step 1: Review */}
      {step === 1 && (
        <div className="space-y-5">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Confirm pool configuration
          </p>

          <div className="divide-y divide-vault-border rounded-2xl border border-vault-border/40 bg-vault-surface/40 px-5 py-1 space-y-1">
            <ReviewRow label="Pool name" value={form.name} />
            <ReviewRow label="Asset" value={form.asset} />
            <ReviewRow label="Minimum deposit" value={`${form.minDeposit} ${form.asset}`} />
            <ReviewRow label="Maximum deposit" value={`${form.maxDeposit} ${form.asset}`} />
            <ReviewRow label="Max participants" value={form.maxParticipants} />
            <ReviewRow
              label="Lockup"
              value={LOCKUP_OPTIONS.find((o) => o.value === form.lockup)?.label ?? "Flexible"}
            />
            <ReviewRow label="Reward weight" value={`${form.rewardYieldPct} bps`} />
            <ReviewRow label="Start date" value={form.startDate} />
            <ReviewRow label="End date" value={form.endDate} />
            {form.description && <ReviewRow label="Description" value={form.description} />}
          </div>

          <div className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-xs text-vault-muted">
            <p className="font-semibold text-vault-text mb-1">Before you submit</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>Pool parameters must match the smart contract constraints.</li>
              <li>Once created, pool parameters can only be changed via multisig governance.</li>
              <li>This action requires wallet signing and network gas.</li>
            </ul>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={() => setStep(0)} className="vq-btn-ghost">
              <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" /> Back
            </button>
            <button type="button" onClick={handleSubmit} className="vq-btn-primary">
              <Wallet className="h-4 w-4" aria-hidden="true" />
              Sign & Create Pool
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Submitting */}
      {step === 2 && (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-red-500/30">
            <Loader2 className="h-8 w-8 animate-spin text-red-400" />
          </div>
          <h3 className="text-lg font-semibold text-vault-text">Creating pool...</h3>
          <p className="text-sm text-vault-muted max-w-xs text-center">
            Approve the transaction in your connected wallet. Do not close this window.
          </p>
        </div>
      )}

      {/* Step 3: Success */}
      {step === 3 && (
        <div className="flex flex-col items-center justify-center py-12 space-y-4 max-w-md mx-auto">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
            <CheckCircle2 className="h-10 w-10" />
          </div>
          <h3 className="text-2xl font-bold text-vault-text">Pool Created!</h3>
          <p className="text-sm text-vault-muted text-center">
            The pool <strong className="text-vault-text">{form.name}</strong> has been created and is now accepting deposits.
          </p>
          <button type="button" onClick={() => { setStep(0); setForm({ name: "", asset: "XLM", minDeposit: "100", maxDeposit: "250000", maxParticipants: "1000", startDate: "", endDate: "", lockup: 0, rewardYieldPct: "100", description: "" }); }} className="vq-btn-primary mt-4">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create another pool
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ label, value }) {
  return (
    <div className="flex justify-between py-2.5">
      <span className="text-vault-muted">{label}</span>
      <span className="font-medium text-vault-text text-right max-w-[60%]">{value}</span>
    </div>
  );
}
