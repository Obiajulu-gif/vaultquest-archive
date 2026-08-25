import Modal from "./Modal";
import { AlertCircle, ShieldAlert, Coins } from "lucide-react";

interface WalletFundingModalProps {
  isOpen: boolean;
  onClose: () => void;
  exists: boolean;
  balance: number;
  minRequired: number;
  network?: "mainnet" | "testnet";
}

const WalletFundingModal = ({
  isOpen,
  onClose,
  exists,
  balance,
  minRequired,
}: WalletFundingModalProps) => {
  if (!isOpen) return null;

  const title = !exists ? "Wallet Activation Required" : "Low XLM Balance";
  const message = !exists
    ? "Your Stellar account hasn't been activated yet. You need to send at least 1 XLM to this address to start using the TrustQuest DApp."
    : `Your balance is ${balance.toFixed(2)} XLM. We recommend at least ${minRequired.toFixed(2)} XLM to ensure you can cover transaction fees.`;

  return (
    <Modal
      onClose={onClose}
      ariaLabelledBy="funding-modal-title"
      ariaDescribedBy="funding-modal-desc"
    >
      <div className="flex flex-col items-center text-center gap-6">
        <div className="w-20 h-20 bg-red-600/20 rounded-full flex items-center justify-center text-red-500 border border-red-500/30 animate-pulse">
          {!exists ? <ShieldAlert size={40} /> : <Coins size={40} />}
        </div>
        
        <div className="space-y-2">
          <h3 id="funding-modal-title" className="text-2xl font-bold text-white tracking-tight">{title}</h3>
          <p id="funding-modal-desc" className="text-gray-400 leading-relaxed text-sm">
            {message}
          </p>
        </div>

        <div className="w-full bg-red-600/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 text-left">
          <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
          <p className="text-xs text-red-200/80 leading-normal">
            Stellar requires a minimum balance of 1 XLM to keep an account active. Without this, transactions will fail.
          </p>
        </div>

        <button
          onClick={onClose}
          className="w-full py-4 px-6 bg-red-600 hover:bg-red-700 text-white rounded-full font-bold text-lg shadow-lg shadow-red-900/20 transition-all transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
        >
          Got it
        </button>
      </div>
    </Modal>
  );
};

export default WalletFundingModal;
