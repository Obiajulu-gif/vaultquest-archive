import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AccessibleField,
  AccessibleButton,
  AccessibleCheckbox,
  AccessibleSelect,
  AccessibleAlert,
} from "../components/ui/AccessibleField";

/**
 * Accessibility tests for form components
 * Covers WCAG 2.1 Level AA requirements:
 * - 1.3.1 Info and Relationships
 * - 2.1.1 Keyboard
 * - 2.4.7 Focus Visible
 * - 3.3.1 Error Identification
 * - 3.3.2 Labels or Instructions
 */

describe("AccessibleField", () => {
  it("renders semantic label element associated with input", () => {
    render(<AccessibleField id="name" label="Full Name" />);

    const label = screen.getByText("Full Name");
    const input = screen.getByRole("textbox");

    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", "name");
    expect(input).toHaveAttribute("id", "name");
  });

  it("marks required fields with aria-required and visual indicator", () => {
    render(
      <AccessibleField id="email" label="Email" required={true} />
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText("required")).toBeInTheDocument();
  });

  it("links error message with aria-describedby", () => {
    render(
      <AccessibleField
        id="age"
        label="Age"
        error="Must be 18 or older"
      />
    );

    const input = screen.getByRole("textbox");
    const error = screen.getByText("Must be 18 or older");

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "age-error");
    expect(error).toHaveAttribute("id", "age-error");
    expect(error).toHaveAttribute("role", "alert");
  });

  it("links help text with aria-describedby", () => {
    render(
      <AccessibleField
        id="password"
        label="Password"
        helpText="At least 8 characters"
      />
    );

    const input = screen.getByRole("textbox");
    const help = screen.getByText("At least 8 characters");

    expect(input).toHaveAttribute("aria-describedby", "password-help");
    expect(help).toHaveAttribute("id", "password-help");
  });

  it("prioritizes error message when both error and help text exist", () => {
    render(
      <AccessibleField
        id="field"
        label="Field"
        error="This field has an error"
        helpText="This is help text"
      />
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-describedby", "field-error");
    expect(screen.queryByText("This is help text")).not.toBeInTheDocument();
    expect(screen.getByText("This field has an error")).toBeInTheDocument();
  });

  it("is keyboard navigable (Tab to focus)", async () => {
    const user = userEvent.setup();
    render(
      <form>
        <AccessibleField id="first" label="First" />
        <AccessibleField id="second" label="Second" />
      </form>
    );

    const firstInput = screen.getAllByRole("textbox")[0];
    const secondInput = screen.getAllByRole("textbox")[1];

    expect(firstInput).not.toHaveFocus();
    await user.tab();
    expect(firstInput).toHaveFocus();
    await user.tab();
    expect(secondInput).toHaveFocus();
  });

  it("passes through input attributes", () => {
    render(
      <AccessibleField
        id="email"
        label="Email"
        type="email"
        placeholder="you@example.com"
        maxLength={50}
      />
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("placeholder", "you@example.com");
    expect(input).toHaveAttribute("maxlength", "50");
  });

  it("disables input when disabled prop is true", () => {
    render(
      <AccessibleField id="name" label="Name" disabled={true} />
    );

    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
  });
});

describe("AccessibleButton", () => {
  it("renders as button with semantic HTML", () => {
    render(<AccessibleButton>Click me</AccessibleButton>);

    const button = screen.getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveTextContent("Click me");
  });

  it("is keyboard accessible (Enter/Space)", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<AccessibleButton onClick={handleClick}>Submit</AccessibleButton>);

    const button = screen.getByRole("button");

    await user.tab();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(handleClick).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(handleClick).toHaveBeenCalledTimes(2);
  });

  it("supports aria-label for context", () => {
    render(
      <AccessibleButton ariaLabel="Close dialog">
        ✕
      </AccessibleButton>
    );

    const button = screen.getByRole("button", { name: "Close dialog" });
    expect(button).toBeInTheDocument();
  });

  it("supports aria-describedby", () => {
    render(
      <>
        <div id="help-text">This will delete the file</div>
        <AccessibleButton ariaDescribedBy="help-text">
          Delete
        </AccessibleButton>
      </>
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-describedby", "help-text");
  });

  it("disables button when disabled prop is true", () => {
    render(
      <AccessibleButton disabled={true}>
        Disabled
      </AccessibleButton>
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("applies variant classes correctly", () => {
    const { rerender } = render(
      <AccessibleButton variant="primary">Primary</AccessibleButton>
    );

    let button = screen.getByRole("button");
    expect(button).toHaveClass("bg-blue-600");

    rerender(
      <AccessibleButton variant="danger">Delete</AccessibleButton>
    );

    button = screen.getByRole("button");
    expect(button).toHaveClass("bg-red-600");
  });
});

describe("AccessibleCheckbox", () => {
  it("renders checkbox with associated label", () => {
    render(
      <AccessibleCheckbox
        id="agree"
        label="I agree to the terms"
        checked={false}
        onChange={() => {}}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    const label = screen.getByText("I agree to the terms");

    expect(checkbox).toHaveAttribute("id", "agree");
    expect(label).toHaveAttribute("for", "agree");
  });

  it("marks required checkboxes", () => {
    render(
      <AccessibleCheckbox
        id="agree"
        label="I agree"
        required={true}
        checked={false}
        onChange={() => {}}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveAttribute("aria-required", "true");
  });

  it("links help text with aria-describedby", () => {
    render(
      <AccessibleCheckbox
        id="consent"
        label="I consent to processing"
        helpText="Your data will be kept secure"
        checked={false}
        onChange={() => {}}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    const help = screen.getByText("Your data will be kept secure");

    expect(checkbox).toHaveAttribute("aria-describedby", "consent-help");
    expect(help).toHaveAttribute("id", "consent-help");
  });

  it("is keyboard accessible", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(
      <AccessibleCheckbox
        id="agree"
        label="I agree"
        checked={false}
        onChange={handleChange}
      />
    );

    const checkbox = screen.getByRole("checkbox");

    await user.tab();
    expect(checkbox).toHaveFocus();

    await user.keyboard(" ");
    expect(handleChange).toHaveBeenCalled();
  });
});

describe("AccessibleSelect", () => {
  const options = [
    { value: "us", label: "United States" },
    { value: "ca", label: "Canada" },
    { value: "mx", label: "Mexico" },
  ];

  it("renders select with associated label", () => {
    render(
      <AccessibleSelect
        id="country"
        label="Country"
        options={options}
        value=""
        onChange={() => {}}
      />
    );

    const select = screen.getByRole("combobox");
    const label = screen.getByText("Country");

    expect(select).toHaveAttribute("id", "country");
    expect(label).toHaveAttribute("for", "country");
  });

  it("renders all options", () => {
    render(
      <AccessibleSelect
        id="country"
        label="Country"
        options={options}
        value=""
        onChange={() => {}}
      />
    );

    const optionElements = screen.getAllByRole("option");
    expect(optionElements).toHaveLength(4); // Including "Select an option"
  });

  it("links error message with aria-describedby", () => {
    render(
      <AccessibleSelect
        id="country"
        label="Country"
        options={options}
        value=""
        error="Country is required"
        onChange={() => {}}
      />
    );

    const select = screen.getByRole("combobox");
    const error = screen.getByText("Country is required");

    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAttribute("aria-describedby", "country-error");
    expect(error).toHaveAttribute("id", "country-error");
  });

  it("marks required selects", () => {
    render(
      <AccessibleSelect
        id="country"
        label="Country"
        options={options}
        value=""
        required={true}
        onChange={() => {}}
      />
    );

    const select = screen.getByRole("combobox");
    expect(select).toHaveAttribute("aria-required", "true");
  });
});

describe("AccessibleAlert", () => {
  it("renders with role=status for live region", () => {
    render(<AccessibleAlert type="success">Success!</AccessibleAlert>);

    const alert = screen.getByRole("status");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("aria-live", "polite");
  });

  it("renders with role=alert for important messages", () => {
    render(
      <AccessibleAlert type="error" role="alert">
        Error occurred
      </AccessibleAlert>
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "polite");
  });

  it("applies type-specific classes", () => {
    const { rerender } = render(
      <AccessibleAlert type="success">OK</AccessibleAlert>
    );

    let alert = screen.getByRole("status");
    expect(alert).toHaveClass("bg-green-50");

    rerender(
      <AccessibleAlert type="error">Error</AccessibleAlert>
    );

    alert = screen.getByRole("status");
    expect(alert).toHaveClass("bg-red-50");
  });
});

/**
 * Integration tests for keyboard navigation in forms
 */
describe("Form Accessibility Integration", () => {
  it("allows tabbing through entire form in logical order", async () => {
    const user = userEvent.setup();

    render(
      <form>
        <AccessibleField id="name" label="Name" />
        <AccessibleCheckbox
          id="agree"
          label="I agree"
          checked={false}
          onChange={() => {}}
        />
        <AccessibleButton>Submit</AccessibleButton>
      </form>
    );

    const nameInput = screen.getByRole("textbox");
    const checkbox = screen.getByRole("checkbox");
    const button = screen.getByRole("button");

    await user.tab();
    expect(nameInput).toHaveFocus();

    await user.tab();
    expect(checkbox).toHaveFocus();

    await user.tab();
    expect(button).toHaveFocus();
  });

  it("focuses first error field on form submit", async () => {
    const user = userEvent.setup();

    const FormWithValidation = () => {
      const [errors, setErrors] = React.useState({});
      const firstInputRef = React.useRef(null);

      const handleSubmit = (e) => {
        e.preventDefault();
        const newErrors = {
          name: "Name is required",
          email: "Email is required",
        };
        setErrors(newErrors);
        firstInputRef.current?.focus();
      };

      return (
        <form onSubmit={handleSubmit}>
          <AccessibleField
            ref={firstInputRef}
            id="name"
            label="Name"
            error={errors.name}
          />
          <AccessibleField
            id="email"
            label="Email"
            error={errors.email}
          />
          <AccessibleButton type="submit">Submit</AccessibleButton>
        </form>
      );
    };

    render(<FormWithValidation />);

    const submitButton = screen.getByRole("button");
    await user.click(submitButton);

    const nameInput = screen.getByRole("textbox", { name: "Name" });
    expect(nameInput).toHaveFocus();
  });
});
