import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ProfileEditor from "../components/app/ProfileEditor";

// Mock wagmi
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x123..." })
}));

// Mock useToast
vi.mock("@/hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() })
}));

describe("ProfileEditor Accessibility", () => {
  it("sets aria-invalid to false initially", () => {
    render(<ProfileEditor />);
    const nameInput = screen.getByLabelText(/Display Name/i);
    expect(nameInput).toHaveAttribute("aria-invalid", "false");
  });

  it("sets aria-invalid and shows error messages when validation fails", async () => {
    render(<ProfileEditor />);
    const saveButton = screen.getByRole("button", { name: /Save Changes/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/Display Name/i);
      expect(nameInput).toHaveAttribute("aria-invalid", "true");
      
      const errorId = nameInput.getAttribute("aria-describedby");
      expect(errorId).toBeTruthy();
      
      const errorEl = document.getElementById(errorId);
      expect(errorEl).toBeInTheDocument();
      expect(errorEl).toHaveTextContent(/Name is required/i);
    });
  });
});
