/**
 * API routes for historical trend aggregation
 *
 * Provides endpoints for:
 * - Aggregating trend metrics over time windows
 * - Exporting trend data with schema versioning
 * - Retrieving persisted trend aggregates
 */

import type { FastifyInstance } from "fastify";
import { TrendAggregationService, type TrendMetric, type AggregationWindow, type TrendExport } from "../services/trendAggregationService.js";

export function trendAggregationRoutes(service: TrendAggregationService, apiKeyGuard?: any) {
  return async (fastify: FastifyInstance) => {

  /**
   * GET /trends/aggregate
   *
   * Aggregate trend data for a specific metric and time range
   *
   * Query params:
   * - metricName: The metric to aggregate (required)
   * - window: Aggregation window (hour, day, week, month) (required)
   * - startDate: ISO date string (required)
   * - endDate: ISO date string (required)
   * - includeMetadata: Whether to include metadata (optional, default false)
   */
  fastify.get("/trends/aggregate", async (request, reply) => {
    const { metricName, window, startDate, endDate, includeMetadata } = request.query as {
      metricName: TrendMetric;
      window: AggregationWindow;
      startDate: string;
      endDate: string;
      includeMetadata?: string;
    };

    // Validate inputs
    if (!metricName || !window || !startDate || !endDate) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "metricName, window, startDate, and endDate are required",
        },
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Invalid date format",
        },
      });
    }

    if (start >= end) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "startDate must be before endDate",
        },
      });
    }

    try {
      const result = await service.aggregateTrends({
        metricName,
        window,
        startDate: start,
        endDate: end,
        includeMetadata: includeMetadata === "true",
      });

      return reply.send({ data: result });
    } catch (error) {
      request.log.error(error, "Failed to aggregate trends");
      return reply.status(500).send({
        error: {
          code: "INTERNAL",
          message: "Failed to aggregate trends",
        },
      });
    }
  });

  /**
   * GET /trends/aggregate-multiple
   *
   * Aggregate multiple metrics for a time range
   *
   * Query params:
   * - metrics: Comma-separated list of metric names (required)
   * - window: Aggregation window (hour, day, week, month) (required)
   * - startDate: ISO date string (required)
   * - endDate: ISO date string (required)
   */
  fastify.get("/trends/aggregate-multiple", async (request, reply) => {
    const { metrics, window, startDate, endDate } = request.query as {
      metrics: string;
      window: AggregationWindow;
      startDate: string;
      endDate: string;
    };

    // Validate inputs
    if (!metrics || !window || !startDate || !endDate) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "metrics, window, startDate, and endDate are required",
        },
      });
    }

    const metricArray = metrics.split(",") as TrendMetric[];
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Invalid date format",
        },
      });
    }

    try {
      const result = await service.aggregateMultipleMetrics(
        metricArray,
        window,
        start,
        end
      );

      return reply.send({ data: result });
    } catch (error) {
      request.log.error(error, "Failed to aggregate multiple trends");
      return reply.status(500).send({
        error: {
          code: "INTERNAL",
          message: "Failed to aggregate multiple trends",
        },
      });
    }
  });

  /**
   * GET /trends/export
   *
   * Export trend data for a time range
   *
   * Query params:
   * - metrics: Comma-separated list of metric names (required)
   * - windows: Comma-separated list of windows (required)
   * - startDate: ISO date string (required)
   * - endDate: ISO date string (required)
   */
  fastify.get("/trends/export", async (request, reply) => {
    const { metrics, windows, startDate, endDate } = request.query as {
      metrics: string;
      windows: string;
      startDate: string;
      endDate: string;
    };

    // Validate inputs
    if (!metrics || !windows || !startDate || !endDate) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "metrics, windows, startDate, and endDate are required",
        },
      });
    }

    const metricArray = metrics.split(",") as TrendMetric[];
    const windowArray = windows.split(",") as AggregationWindow[];
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Invalid date format",
        },
      });
    }

    try {
      const result = await service.exportTrends(
        metricArray,
        windowArray,
        start,
        end
      );

      // Set appropriate headers for export
      reply.header("Content-Type", "application/json");
      reply.header("Content-Disposition", `attachment; filename="trends-export-${Date.now()}.json"`);

      return reply.send(result);
    } catch (error) {
      request.log.error(error, "Failed to export trends");
      return reply.status(500).send({
        error: {
          code: "INTERNAL",
          message: "Failed to export trends",
        },
      });
    }
  });

  /**
   * GET /trends/persisted
   *
   * Retrieve persisted trend aggregates
   *
   * Query params:
   * - metricName: The metric name (required)
   * - window: Aggregation window (required)
   * - startDate: ISO date string (required)
   * - endDate: ISO date string (required)
   */
  fastify.get("/trends/persisted", async (request, reply) => {
    const { metricName, window, startDate, endDate } = request.query as {
      metricName: TrendMetric;
      window: AggregationWindow;
      startDate: string;
      endDate: string;
    };

    // Validate inputs
    if (!metricName || !window || !startDate || !endDate) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "metricName, window, startDate, and endDate are required",
        },
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Invalid date format",
        },
      });
    }

    try {
      const result = await service.getAggregates(metricName, window, start, end);
      return reply.send({ data: result });
    } catch (error) {
      request.log.error(error, "Failed to retrieve persisted trends");
      return reply.status(500).send({
        error: {
          code: "INTERNAL",
          message: "Failed to retrieve persisted trends",
        },
      });
    }
  });

  /**
   * POST /trends/persist
   *
   * Persist trend aggregate data
   *
   * Requires admin authentication
   */
  fastify.post("/trends/persist", async (request, reply) => {
    // Check admin authentication
    if (!request.isAdmin) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Admin access required",
        },
      });
    }

    const aggregate = request.body as Omit<
      Parameters<typeof service.persistAggregate>[0],
      "id" | "createdAt" | "updatedAt"
    >;

    if (!aggregate.metricName || !aggregate.window || !aggregate.windowStart || !aggregate.windowEnd) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "metricName, window, windowStart, and windowEnd are required",
        },
      });
    }

    try {
      const result = await service.persistAggregate(aggregate);
      return reply.send({ data: result });
    } catch (error) {
      request.log.error(error, "Failed to persist trend aggregate");
      return reply.status(500).send({
        error: {
          code: "INTERNAL",
          message: "Failed to persist trend aggregate",
        },
      });
    }
  });
  };
}
