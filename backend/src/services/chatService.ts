import { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";

export interface ChatMessage {
  roomId: string;
  senderId: string;
  content: string;
  timestamp: Date;
}

export interface ChatConfig {
  prisma: PrismaClient;
  logger?: Logger;
  sessionTtlMs?: number;
}

export class ChatService {
  private readonly io: Server;
  private readonly prisma: PrismaClient;
  private readonly logger?: Logger;
  private readonly sessionTtlMs: number;

  constructor(httpServer: HttpServer, config: ChatConfig) {
    this.prisma = config.prisma;
    this.logger = config.logger;
    this.sessionTtlMs = config.sessionTtlMs || 24 * 60 * 60 * 1000;

    this.io = new Server(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupMiddleware();
    this.setupEventHandlers();
  }

  private setupMiddleware(): void {
    this.io.use(async (socket, next) => {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error("Authentication required"));
      }

      try {
        const session = await this.prisma.walletSession.findUnique({
          where: { token }
        });

        if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
          return next(new Error("Invalid or expired session"));
        }

        (socket as any).userId = session.walletAddress;
        (socket as any).publicKey = session.publicKey;
        (socket as any).network = session.network;
        next();
      } catch {
        next(new Error("Authentication failed"));
      }
    });
  }

  private setupEventHandlers(): void {
    this.io.on("connection", (socket: Socket) => {
      const userId = (socket as any).userId as string;
      this.logger?.info({ userId, socketId: socket.id }, "Client connected");

      socket.on("join_room", async (roomId: string) => {
        if (!roomId || typeof roomId !== "string") {
          socket.emit("error", { message: "Invalid room ID" });
          return;
        }

        socket.join(roomId);
        this.logger?.info({ userId, roomId }, "User joined room");

        socket.to(roomId).emit("user_joined", {
          userId,
          roomId,
          timestamp: new Date()
        });

        socket.emit("room_joined", { roomId, timestamp: new Date() });
      });

      socket.on("send_message", async (data: { roomId: string; content: string }) => {
        if (!data.roomId || !data.content || typeof data.content !== "string") {
          socket.emit("error", { message: "Invalid message data" });
          return;
        }

        if (data.content.length > 5000) {
          socket.emit("error", { message: "Message too long" });
          return;
        }

        const message: ChatMessage = {
          roomId: data.roomId,
          senderId: userId,
          content: data.content.trim(),
          timestamp: new Date()
        };

        this.io.to(data.roomId).emit("new_message", message);
        this.logger?.debug({ userId, roomId: data.roomId }, "Message broadcast");
      });

      socket.on("leave_room", (roomId: string) => {
        socket.leave(roomId);
        socket.to(roomId).emit("user_left", {
          userId,
          roomId,
          timestamp: new Date()
        });
        this.logger?.info({ userId, roomId }, "User left room");
      });

      socket.on("disconnect", (reason) => {
        this.logger?.info({ userId, reason }, "Client disconnected");
      });
    });
  }

  getIo(): Server {
    return this.io;
  }

  async close(): Promise<void> {
    this.io.close();
  }
}
