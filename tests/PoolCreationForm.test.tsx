import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import PoolCreationForm from "../components/app/PoolCreationForm";

describe("PoolCreationForm Accessibility", () => {
  it("shows no aria-invalid on initial render", () => {
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    const nameInput = screen.getByLabelText(/Pool name/i);
    expect(nameInput).toHaveAttribute("aria-invalid", "false");
  });

  it("sets aria-invalid and aria-describedby when form validation fails", async () => {
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    
    const nextButton = screen.getByRole("button", { name: /Review/i });
    fireEvent.click(nextButton);

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/Pool name/i);
      expect(nameInput).toHaveAttribute("aria-invalid", "true");
      
      const errorId = nameInput.getAttribute("aria-describedby");
      expect(errorId).toBeTruthy();
      
      const errorMessage = document.getElementById(errorId);
      expect(errorMessage).toBeInTheDocument();
      expect(errorMessage).toHaveTextContent(/at least/i);
    });
  });
});
