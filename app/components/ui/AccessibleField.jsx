/**
 * AccessibleField: Semantic form field with WCAG 2.1 compliance
 *
 * Features:
 * - Proper <label> association
 * - Error message linked via aria-describedby
 * - Help text support
 * - Focus management
 */
import React, { forwardRef } from "react";

export const AccessibleField = forwardRef(function AccessibleField({
  label,
  id,
  error,
  helpText,
  required = false,
  disabled = false,
  type = "text",
  className = "",
  ...inputProps
}, ref) {
  const describedBy = [
    error ? `${id}-error` : null,
    helpText && !error ? `${id}-help` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`mb-6 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900 mb-2">
        {label}
        {required && (
          <span aria-label="required" className="text-red-600 ml-1">
            *
          </span>
        )}
      </label>

      <input
        ref={ref}
        id={id}
        type={type}
        disabled={disabled}
        required={required}
        aria-required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy || undefined}
        className={`w-full px-4 py-2 border rounded-lg transition-colors ${
          error
            ? "border-red-500 bg-red-50 text-gray-900 placeholder-red-300 focus-visible:outline-red-500"
            : "border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus-visible:outline-blue-500"
        } focus-visible:outline-2 focus-visible:outline-offset-0 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed`}
        {...inputProps}
      />

      {error && (
        <div
          id={`${id}-error`}
          role="alert"
          className="mt-2 text-sm text-red-600 font-medium"
        >
          {error}
        </div>
      )}

      {helpText && !error && (
        <div id={`${id}-help`} className="mt-2 text-sm text-gray-600">
          {helpText}
        </div>
      )}
    </div>
  );
});

/**
 * AccessibleButton: Semantic button with visible focus state
 */
export function AccessibleButton({
  children,
  type = "button",
  variant = "primary",
  disabled = false,
  ariaLabel,
  ariaDescribedBy,
  className = "",
  ...buttonProps
}) {
  const baseClasses =
    "px-4 py-2 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2";

  const variantClasses = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 focus-visible:outline-blue-500",
    secondary: "bg-gray-200 text-gray-900 hover:bg-gray-300 focus-visible:outline-gray-600",
    danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-500",
  };

  return (
    <button
      type={type}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className={`${baseClasses} ${variantClasses[variant]} ${
        disabled ? "opacity-50 cursor-not-allowed" : ""
      } ${className}`}
      {...buttonProps}
    >
      {children}
    </button>
  );
}

/**
 * AccessibleCheckbox: Semantic checkbox with proper labeling
 */
export function AccessibleCheckbox({
  id,
  label,
  checked,
  onChange,
  required = false,
  helpText,
  className = "",
  ...checkboxProps
}) {
  return (
    <div className={`mb-4 ${className}`}>
      <div className="flex items-start">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          required={required}
          aria-required={required}
          aria-describedby={helpText ? `${id}-help` : undefined}
          className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-blue-500"
          {...checkboxProps}
        />
        <label htmlFor={id} className="ml-3 text-sm text-gray-700">
          {label}
          {required && <span className="text-red-600">*</span>}
        </label>
      </div>
      {helpText && (
        <div id={`${id}-help`} className="ml-7 mt-1 text-sm text-gray-600">
          {helpText}
        </div>
      )}
    </div>
  );
}

/**
 * AccessibleSelect: Semantic select dropdown
 */
export function AccessibleSelect({
  id,
  label,
  options,
  value,
  onChange,
  error,
  helpText,
  required = false,
  disabled = false,
  className = "",
  ...selectProps
}) {
  const describedBy = [
    error ? `${id}-error` : null,
    helpText && !error ? `${id}-help` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`mb-6 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900 mb-2">
        {label}
        {required && <span className="text-red-600">*</span>}
      </label>

      <select
        id={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
        required={required}
        aria-required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy || undefined}
        className={`w-full px-4 py-2 border rounded-lg transition-colors ${
          error
            ? "border-red-500 bg-red-50 text-gray-900 focus-visible:outline-red-500"
            : "border-gray-300 bg-white text-gray-900 focus-visible:outline-blue-500"
        } focus-visible:outline-2 focus-visible:outline-offset-0 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed`}
        {...selectProps}
      >
        <option value="">Select an option</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {error && (
        <div id={`${id}-error`} role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </div>
      )}

      {helpText && !error && (
        <div id={`${id}-help`} className="mt-2 text-sm text-gray-600">
          {helpText}
        </div>
      )}
    </div>
  );
}

/**
 * AccessibleAlert: Semantic alert message for status updates
 */
export function AccessibleAlert({ type = "info", children, role = "status" }) {
  const typeClasses = {
    success: "bg-green-50 border-green-200 text-green-800",
    error: "bg-red-50 border-red-200 text-red-800",
    warning: "bg-yellow-50 border-yellow-200 text-yellow-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  };

  return (
    <div
      role={role}
      aria-live="polite"
      className={`p-4 rounded-lg border ${typeClasses[type]}`}
    >
      {children}
    </div>
  );
}
