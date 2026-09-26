import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { PrismaClient } from "@prisma/client";

export const usersRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;

  fastify.get(
    "/me",
    {
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const userPayload = (request as any).user;
      
      let user = await prisma.user.findUnique({
        where: { id: userPayload.id },
        select: { id: true, name: true, email: true, bio: true, walletAddress: true, createdAt: true, updatedAt: true }
      });

      // For the sake of this mock, if the user doesn't exist, we return a mock or create one
      if (!user) {
         // mock response if the user doesn't exist in our DB yet
         return reply.send({
           id: userPayload.id,
           name: "Demo User",
           email: "demo@example.com",
           bio: "VaultQuest Saver",
           walletAddress: null,
           createdAt: new Date().toISOString(),
           updatedAt: new Date().toISOString(),
         });
      }

      return reply.send(user);
    }
  );

  const updateProfileSchema = z.object({
    name: z.string().optional(),
    bio: z.string().optional(),
    email: z.string().email().optional(),
  });

  fastify.put(
    "/me",
    {
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const userPayload = (request as any).user;
      
      const parseResult = updateProfileSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: "Bad Request",
          details: parseResult.error.format(),
        });
      }

      const updates = parseResult.data;

      // In a real application, you would update the user in the database
      // await prisma.user.update({
      //   where: { id: userPayload.id },
      //   data: updates,
      // });

      return reply.send({
        success: true,
        message: "Profile updated successfully",
        data: updates,
      });
    }
  );
};
