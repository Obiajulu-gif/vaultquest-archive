"use client";

import { useState } from "react";
import { Bell, CheckCircle2 } from "lucide-react";

export default function VaultNotificationSettings() {
  const [settings, setSettings] = useState({
    roundUpdates: true,
    actionStatus: true,
    winnings: true,
    deposits: false,
  });
  const [showSaved, setShowSaved] = useState(false);

  const toggleSetting = (key) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSave = () => {
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 3000);
  };

  return (
    <section className="vq-glass-hover p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
          <Bell size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-vault-text">
            Notification Preferences
          </h3>
          <p className="text-sm text-vault-muted">Manage your vault alerts</p>
        </div>
      </div>

      <div className="space-y-3 border-t border-vault-border pt-4">
        <label className="flex items-center justify-between cursor-pointer group">
          <div>
            <p className="font-medium text-vault-text group-hover:text-vault-accent transition-colors">
              Round Updates
            </p>
            <p className="text-xs text-vault-muted">
              Get notified when rounds complete
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.roundUpdates}
            onChange={() => toggleSetting("roundUpdates")}
            className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent"
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer group">
          <div>
            <p className="font-medium text-vault-text group-hover:text-vault-accent transition-colors">
              Action Status Updates
            </p>
            <p className="text-xs text-vault-muted">
              Deposits, withdrawals, and claims
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.actionStatus}
            onChange={() => toggleSetting("actionStatus")}
            className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent"
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer group">
          <div>
            <p className="font-medium text-vault-text group-hover:text-vault-accent transition-colors">
              Winning Notifications
            </p>
            <p className="text-xs text-vault-muted">
              Alert when you win a prize
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.winnings}
            onChange={() => toggleSetting("winnings")}
            className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent"
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer group">
          <div>
            <p className="font-medium text-vault-text group-hover:text-vault-accent transition-colors">
              Deposit Confirmations
            </p>
            <p className="text-xs text-vault-muted">
              Confirm each deposit action
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.deposits}
            onChange={() => toggleSetting("deposits")}
            className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent"
          />
        </label>
      </div>

      <button onClick={handleSave} className="vq-btn-primary w-full">
        Save Preferences
      </button>

      {showSaved && (
        <div className="flex items-center gap-2 text-sm text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
          <CheckCircle2 size={16} />
          <span>Notification preferences saved successfully</span>
        </div>
      )}
    </section>
  );
}
