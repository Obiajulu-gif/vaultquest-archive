"use client";

import { Component } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

function logError(error, info) {
  if (typeof window !== "undefined" && window.__sentryReady) {
    try {
      const Sentry = require("@sentry/nextjs");
      Sentry.captureException(error, { extra: { componentStack: info?.componentStack } });
      return;
    } catch {
      // Sentry not available
    }
  }
  console.error("[ErrorBoundary]", error, info?.componentStack);
}

export default class RouteErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    logError(error, info);
  }

  reset() {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <RouteErrorFallback error={this.state.error} reset={this.reset} />;
    }
    return this.props.children;
  }
}
