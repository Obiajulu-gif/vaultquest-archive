import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import type { CategoryService } from "../services/categoryService.js";
import { ok } from "../responses.js";

function serialize(row: Awaited<ReturnType<CategoryService["listCategories"]>>[number]) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

export const categoriesRoutes = (
  svc: CategoryService,
  apiKeyGuard: preHandlerHookHandler
): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/categories", { preHandler: apiKeyGuard }, async () => {
      const rows = await svc.listCategories();
      return ok(rows.map(serialize));
    });
  };
