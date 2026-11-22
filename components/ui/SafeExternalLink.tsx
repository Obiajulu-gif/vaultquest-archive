import React from "react";
import { toSafeExternalLink, type SanitizeUrlOptions } from "@/lib/safe-content";

type SafeExternalLinkProps = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target" | "rel"
> & {
  /** Untrusted URL. Rendered as a link only if it passes `sanitizeUrl`. */
  href: unknown;
  urlOptions?: SanitizeUrlOptions;
  /** Rendered instead of a link when the URL is unsafe (default: children as plain text). */
  fallback?: React.ReactNode;
};

/**
 * Outbound link for untrusted URLs (#774). Only http(s) URLs without embedded
 * credentials are linked; they always open in a new tab with
 * `noopener noreferrer nofollow`, the destination host is exposed via `title`
 * so link text can't hide it, and assistive tech is told it opens a new tab.
 */
export default function SafeExternalLink({
  href,
  urlOptions,
  fallback,
  children,
  title,
  ...rest
}: SafeExternalLinkProps) {
  const link = toSafeExternalLink(href, urlOptions);
  if (!link) {
    return <span data-unsafe-link="true">{fallback === undefined ? children : fallback}</span>;
  }
  return (
    <a {...rest} href={link.href} target={link.target} rel={link.rel} title={title ?? link.host}>
      {children}
      <span className="sr-only"> (opens {link.host} in a new tab)</span>
    </a>
  );
}
