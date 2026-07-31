"use client";

import { useState, useEffect, useMemo } from "react";
import { useAccount } from "wagmi";
import { User, Save, Award, Sparkles, Check, Settings, Shield, Bell, Lock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/useToast";

const TABS = [
  { id: "general", label: "General", icon: User },
  { id: "security", label: "Security", icon: Shield },
  { id: "notifications", label: "Notifications", icon: Bell },
];

export default function ProfileEditor() {
  const { address } = useAccount();
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState("general");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form states
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    emailAlerts: true,
    pushNotifications: false,
  });

  const [errors, setErrors] = useState({});

  const validate = () => {
    const newErrors = {};
    if (activeTab === "general") {
      if (!formData.name.trim()) newErrors.name = "Name is required";
      if (!formData.email.trim()) newErrors.email = "Email is required";
      else if (!/\S+@\S+\.\S+/.test(formData.email)) newErrors.email = "Invalid email format";
    }
    if (activeTab === "security") {
      if (!formData.currentPassword) newErrors.currentPassword = "Required";
      if (formData.newPassword && formData.newPassword.length < 8) newErrors.newPassword = "Password must be at least 8 characters";
      if (formData.newPassword !== formData.confirmPassword) newErrors.confirmPassword = "Passwords do not match";
    }
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      addToast({ type: "error", message: "Please fix the errors before saving." });
    }
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setSaving(false);
    setSaved(true);
    addToast({ type: "success", message: "Profile updated successfully." });
    setTimeout(() => setSaved(false), 2000);
  };

  if (!address) {
    return (
      <div className="vq-glass p-6 text-center">
        <User className="mx-auto h-12 w-12 text-vault-muted" aria-hidden="true" />
        <p className="mt-3 text-sm text-vault-muted">Connect your wallet to customize your profile</p>
      </div>
    );
  }

  return (
    <div className="vq-glass overflow-hidden flex flex-col md:flex-row min-h-[500px]">
      {/* Sidebar Navigation */}
      <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-vault-border bg-vault-surface/20">
        <div className="p-4 md:p-6 space-y-2">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300 text-sm font-medium ${
                  isActive 
                    ? "bg-red-500/10 text-red-500 ring-1 ring-red-500/30 shadow-glow" 
                    : "text-vault-muted hover:bg-vault-surface/50 hover:text-vault-text"
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? "text-red-500" : ""}`} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-6 md:p-8 relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="max-w-2xl"
          >
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-vault-text">
                {TABS.find((t) => t.id === activeTab)?.label} Settings
              </h2>
              <p className="mt-1 text-sm text-vault-muted">
                Manage your account preferences and configurations here.
              </p>
            </div>

            <div className="space-y-6">
              {activeTab === "general" && (
                <div className="space-y-5">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-vault-text">Display Name</label>
                    <input
                      type="text"
                      className={`w-full bg-vault-surface border ${errors.name ? 'border-red-500' : 'border-vault-border'} rounded-lg px-4 py-2.5 text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all`}
                      placeholder="e.g. DeFi Degen"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    />
                    {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-vault-text">Email Address</label>
                    <input
                      type="email"
                      className={`w-full bg-vault-surface border ${errors.email ? 'border-red-500' : 'border-vault-border'} rounded-lg px-4 py-2.5 text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all`}
                      placeholder="john@example.com"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    />
                    {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-vault-text">Wallet Address</label>
                    <input
                      type="text"
                      disabled
                      className="w-full bg-vault-surface/50 border border-vault-border rounded-lg px-4 py-2.5 text-vault-muted cursor-not-allowed"
                      value={address}
                    />
                  </div>
                </div>
              )}

              {activeTab === "security" && (
                <div className="space-y-5">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-vault-text">Current Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-vault-muted" />
                      <input
                        type="password"
                        className={`w-full bg-vault-surface border ${errors.currentPassword ? 'border-red-500' : 'border-vault-border'} rounded-lg pl-10 pr-4 py-2.5 text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all`}
                        placeholder="••••••••"
                        value={formData.currentPassword}
                        onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
                      />
                    </div>
                    {errors.currentPassword && <p className="text-xs text-red-500 mt-1">{errors.currentPassword}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-vault-text">New Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-vault-muted" />
                      <input
                        type="password"
                        className={`w-full bg-vault-surface border ${errors.newPassword ? 'border-red-500' : 'border-vault-border'} rounded-lg pl-10 pr-4 py-2.5 text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all`}
                        placeholder="••••••••"
                        value={formData.newPassword}
                        onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                      />
                    </div>
                    {errors.newPassword && <p className="text-xs text-red-500 mt-1">{errors.newPassword}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-vault-text">Confirm New Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-vault-muted" />
                      <input
                        type="password"
                        className={`w-full bg-vault-surface border ${errors.confirmPassword ? 'border-red-500' : 'border-vault-border'} rounded-lg pl-10 pr-4 py-2.5 text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all`}
                        placeholder="••••••••"
                        value={formData.confirmPassword}
                        onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                      />
                    </div>
                    {errors.confirmPassword && <p className="text-xs text-red-500 mt-1">{errors.confirmPassword}</p>}
                  </div>
                </div>
              )}

              {activeTab === "notifications" && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between p-4 rounded-xl border border-vault-border bg-vault-surface/40 hover:bg-vault-surface/60 transition-colors">
                    <div>
                      <p className="font-medium text-vault-text">Email Alerts</p>
                      <p className="text-sm text-vault-muted">Receive weekly digests and updates</p>
                    </div>
                    <button 
                      onClick={() => setFormData(f => ({ ...f, emailAlerts: !f.emailAlerts }))}
                      className={`w-12 h-6 rounded-full transition-colors relative ${formData.emailAlerts ? 'bg-red-500' : 'bg-vault-border'}`}
                    >
                      <span className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${formData.emailAlerts ? 'translate-x-6' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  
                  <div className="flex items-center justify-between p-4 rounded-xl border border-vault-border bg-vault-surface/40 hover:bg-vault-surface/60 transition-colors">
                    <div>
                      <p className="font-medium text-vault-text">Push Notifications</p>
                      <p className="text-sm text-vault-muted">Get alerted instantly for deposits</p>
                    </div>
                    <button 
                      onClick={() => setFormData(f => ({ ...f, pushNotifications: !f.pushNotifications }))}
                      className={`w-12 h-6 rounded-full transition-colors relative ${formData.pushNotifications ? 'bg-red-500' : 'bg-vault-border'}`}
                    >
                      <span className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${formData.pushNotifications ? 'translate-x-6' : 'translate-x-0'}`} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Save Button */}
            <div className="mt-10 flex justify-end">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || saved}
                className="vq-btn-primary min-w-[150px] justify-center transition-all disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Saving...
                  </div>
                ) : saved ? (
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Saved!
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Save className="h-4 w-4" aria-hidden="true" />
                    Save Changes
                  </div>
                )}
              </button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
