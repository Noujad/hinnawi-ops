import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerMcpRoutes } from "../mcpRoutes";
import { registerQboOAuthRoutes } from "../qboRoutes";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { startAutoRetryScheduler, getSetting } from "../autoRetry";
import { startKoomiScheduler } from "../koomiScheduler";
import { startSevenShiftsScheduler } from "../sevenShiftsScheduler";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // QBO OAuth routes
  registerQboOAuthRoutes(app);
  // MCP (Model Context Protocol) Streamable HTTP endpoint
  registerMcpRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, async () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Start auto-retry scheduler if enabled
    try {
      const enabled = await getSetting("qbo_auto_retry_enabled");
      if (enabled === "true") {
        startAutoRetryScheduler();
      } else {
        console.log("[AutoRetry] Scheduler not started (disabled in settings)");
      }
    } catch (err) {
      console.log("[AutoRetry] Could not check settings, scheduler not started");
    }
    // Start Koomi daily sync scheduler
    try {
      const koomiEnabled = await getSetting("koomi_auto_sync_enabled");
      if (koomiEnabled === "true") {
        startKoomiScheduler();
      } else {
        console.log("[Koomi Scheduler] Not started (disabled in settings)");
      }
    } catch (err) {
      console.log("[Koomi Scheduler] Could not check settings, scheduler not started");
    }
    // Start 7shifts daily sync scheduler
    try {
      const sevenShiftsEnabled = await getSetting("7shifts_auto_sync_enabled");
      if (sevenShiftsEnabled === "true") {
        startSevenShiftsScheduler();
      } else {
        console.log("[7shifts Scheduler] Not started (disabled in settings)");
      }
    } catch (err) {
      console.log("[7shifts Scheduler] Could not check settings, scheduler not started");
    }
  });
}

startServer().catch(console.error);
