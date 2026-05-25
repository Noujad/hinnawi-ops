/**
 * MCP (Model Context Protocol) Routes — Streamable HTTP Transport
 * 
 * Registers /api/mcp, OAuth 2.1 discovery, and auth endpoints on the Express app.
 * Stateless: fresh McpServer + transport per request.
 * 
 * Auth: ?key=MCP_SECRET, Authorization: Bearer, or x-mcp-key header.
 * OAuth 2.1: Authorization Code + PKCE (auto-approve, machine-to-machine).
 * 
 * Environment variables:
 *   MCP_SECRET          — Static secret for key-based auth (required)
 *   MCP_OAUTH_CLIENT_ID     — OAuth 2.1 client ID
 *   MCP_OAUTH_CLIENT_SECRET — OAuth 2.1 client secret
 */

import { Express, Request, Response } from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { eq, sql, desc, and, gte, lte, asc } from "drizzle-orm";
import { getDb } from "./db";
import {
  locations, dailySales, invoices, suppliers, payrollRecords,
  qboEntities, productSales, revenueJournalEntries, qboAccountCache
} from "../drizzle/schema";

// ─── Configuration ───
const MCP_SECRET = process.env.MCP_SECRET || "";
const OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.MCP_OAUTH_CLIENT_SECRET || "";

function getPublicUrl(req: Request): string {
  // Always derive from request headers for correct behavior behind proxies
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  // Allow PUBLIC_URL override only if explicitly set and not localhost
  if (process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes("localhost")) {
    return process.env.PUBLIC_URL;
  }
  return `${proto}://${host}`;
}

// ─── Helper: format date from Date object to YYYY-MM-DD ───
function toDateStr(d: Date | string | null | undefined): string {
  if (!d) return "";
  if (typeof d === "string") return d;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ─── OAuth 2.1 In-Memory Store ───
interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}
interface AccessToken {
  token: string;
  clientId: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, AccessToken>();

// Clean up expired tokens every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.expiresAt < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.expiresAt < now) accessTokens.delete(k);
}, 60_000);

// ─── Auth Check ───
function authenticate(req: Request, res: Response): boolean {
  // If MCP_SECRET is not configured, MCP is disabled
  if (!MCP_SECRET) {
    res.status(503).json({ error: "MCP not configured" });
    return false;
  }

  // Method 1: ?key= query parameter
  const keyParam = req.query.key as string | undefined;
  if (keyParam && keyParam === MCP_SECRET) return true;

  // Method 2: Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === MCP_SECRET) return true;
    const oauthToken = accessTokens.get(token);
    if (oauthToken && oauthToken.expiresAt > Date.now()) return true;
  }

  // Method 3: x-mcp-key header
  const mcpKeyHeader = req.headers["x-mcp-key"] as string | undefined;
  if (mcpKeyHeader && mcpKeyHeader === MCP_SECRET) return true;

  res.status(401).json({ error: "Unauthorized", message: "Valid key or OAuth token required" });
  return false;
}

// ─── Create MCP Server with all 11 read-only tools ───
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "hinnawi-ops-accounting",
    version: "1.0.0",
  }, {
    capabilities: { tools: {} },
    instructions: `Hinnawi Ops Accounting MCP Server — Read-only access to financial data for Bagel & Cafe restaurant chain (4 locations: President Kennedy/PK-MK, Mackay, Cathcart Tunnel, Ontario).

Available data: daily sales, revenue journal entries, invoices/AP, suppliers, payroll, product sales, QBO entities, chart of accounts.
All monetary values are in CAD. Fiscal year runs Sep 1 – Aug 31.
Ontario location is in Quebec (charges GST 5% + QST 9.975%).`,
  });

  // ─── Tool: get_locations ───
  server.tool(
    "get_locations",
    "List all cafe locations with their codes, names, and targets",
    {},
    async () => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const rows = await db.select().from(locations).orderBy(asc(locations.id));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(rows.map(r => ({
            id: r.id, code: r.code, name: r.name, entityName: r.entityName,
            address: r.address, laborTarget: r.laborTarget, foodCostTarget: r.foodCostTarget, isActive: r.isActive,
          })), null, 2),
        }],
      };
    }
  );

  // ─── Tool: get_daily_sales ───
  server.tool(
    "get_daily_sales",
    "Query daily sales data by date range and/or location. Returns revenue, taxes, tips, deposits, labor costs per day per location.",
    {
      start_date: z.string().describe("Start date in YYYY-MM-DD format"),
      end_date: z.string().describe("End date in YYYY-MM-DD format"),
      location_id: z.number().optional().describe("Filter by location ID (1=PK, 2=Mackay, 3=Ontario, 4=Cathcart)"),
    },
    async ({ start_date, end_date, location_id }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [
        gte(dailySales.saleDate, new Date(start_date)),
        lte(dailySales.saleDate, new Date(end_date)),
      ];
      if (location_id) conditions.push(eq(dailySales.locationId, location_id));

      const rows = await db.select().from(dailySales)
        .where(and(...conditions))
        .orderBy(desc(dailySales.saleDate), asc(dailySales.locationId))
        .limit(500);

      const result = rows.map(r => ({
        id: r.id, locationId: r.locationId, saleDate: toDateStr(r.saleDate as any),
        totalSales: r.totalSales, taxExemptSales: r.taxExemptSales, taxableSales: r.taxableSales,
        gstCollected: r.gstCollected, qstCollected: r.qstCollected, totalDeposit: r.totalDeposit,
        tipsCollected: r.tipsCollected, merchantFees: r.merchantFees, pettyCash: r.pettyCash,
        discounts: r.discounts, labourCost: r.labourCost, orderCount: r.orderCount,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, data: result }, null, 2) }] };
    }
  );

  // ─── Tool: get_revenue_journal_entries ───
  server.tool(
    "get_revenue_journal_entries",
    "Query revenue journal entries from the POS pipeline. Filter by status, location, date range.",
    {
      status: z.enum(["posted", "voided", "deleted", "failed", "pending"]).optional().describe("Filter by JE status"),
      location_id: z.number().optional().describe("Filter by location ID"),
      start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD"),
      limit: z.number().optional().default(100).describe("Max results (default 100)"),
    },
    async ({ status, location_id, start_date, end_date, limit }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [];
      if (status) conditions.push(eq(revenueJournalEntries.status, status));
      if (location_id) conditions.push(eq(revenueJournalEntries.locationId, location_id));
      if (start_date) conditions.push(gte(revenueJournalEntries.saleDate, new Date(start_date)));
      if (end_date) conditions.push(lte(revenueJournalEntries.saleDate, new Date(end_date)));

      const rows = await db.select().from(revenueJournalEntries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(revenueJournalEntries.saleDate))
        .limit(limit || 100);

      const result = rows.map(r => ({
        id: r.id, locationId: r.locationId, saleDate: toDateStr(r.saleDate as any),
        realmId: r.realmId, docNumber: r.docNumber, status: r.status,
        totalSales: r.totalSales, netRevenue: r.netRevenue, gst: r.gst, qst: r.qst,
        taxExemptSales: r.taxExemptSales, taxableSales: r.taxableSales,
        tips: r.tips, pettyCash: r.pettyCash, arAmount: r.arAmount, roundingAdj: r.roundingAdj,
        qboJeId: r.qboJeId, errorMessage: r.errorMessage, postedAt: r.postedAt?.toISOString(),
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, data: result }, null, 2) }] };
    }
  );

  // ─── Tool: get_invoices ───
  server.tool(
    "get_invoices",
    "List accounts payable invoices. Filter by status, supplier, location, or date range.",
    {
      status: z.enum(["pending", "approved", "paid", "rejected"]).optional().describe("Filter by invoice status"),
      supplier_id: z.number().optional().describe("Filter by supplier ID"),
      location_id: z.number().optional().describe("Filter by location ID"),
      start_date: z.string().optional().describe("Invoice date start YYYY-MM-DD"),
      end_date: z.string().optional().describe("Invoice date end YYYY-MM-DD"),
      limit: z.number().optional().default(100).describe("Max results"),
    },
    async ({ status, supplier_id, location_id, start_date, end_date, limit }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [];
      if (status) conditions.push(eq(invoices.status, status));
      if (supplier_id) conditions.push(eq(invoices.supplierId, supplier_id));
      if (location_id) conditions.push(eq(invoices.locationId, location_id));
      if (start_date) conditions.push(gte(invoices.invoiceDate, new Date(start_date)));
      if (end_date) conditions.push(lte(invoices.invoiceDate, new Date(end_date)));

      const rows = await db.select().from(invoices)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(invoices.createdAt))
        .limit(limit || 100);

      const result = rows.map(r => ({
        id: r.id, invoiceNumber: r.invoiceNumber, supplierId: r.supplierId,
        locationId: r.locationId, invoiceDate: toDateStr(r.invoiceDate as any),
        dueDate: toDateStr(r.dueDate as any),
        subtotal: r.subtotal, gst: r.gst, qst: r.qst, total: r.total,
        status: r.status, glAccount: r.glAccount, qboSynced: r.qboSynced,
        qboSyncStatus: r.qboSyncStatus, notes: r.notes,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, data: result }, null, 2) }] };
    }
  );

  // ─── Tool: get_suppliers ───
  server.tool(
    "get_suppliers",
    "List all vendors/suppliers",
    {},
    async () => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const rows = await db.select().from(suppliers).orderBy(asc(suppliers.name));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(rows.map(r => ({
            id: r.id, name: r.name, category: r.category,
            contactName: r.contactName, email: r.email, phone: r.phone,
          })), null, 2),
        }],
      };
    }
  );

  // ─── Tool: get_payroll ───
  server.tool(
    "get_payroll",
    "Query payroll records by date range and/or location",
    {
      start_date: z.string().describe("Start date YYYY-MM-DD"),
      end_date: z.string().describe("End date YYYY-MM-DD"),
      location_id: z.number().optional().describe("Filter by location ID"),
    },
    async ({ start_date, end_date, location_id }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [
        gte(payrollRecords.weekEnding, new Date(start_date)),
        lte(payrollRecords.weekEnding, new Date(end_date)),
      ];
      if (location_id) conditions.push(eq(payrollRecords.locationId, location_id));

      const rows = await db.select().from(payrollRecords)
        .where(and(...conditions))
        .orderBy(desc(payrollRecords.weekEnding))
        .limit(200);

      const result = rows.map(r => ({
        id: r.id, locationId: r.locationId, weekEnding: toDateStr(r.weekEnding as any),
        totalHours: r.totalHours, totalWages: r.totalWages, employeeCount: r.employeeCount,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, data: result }, null, 2) }] };
    }
  );

  // ─── Tool: get_qbo_entities ───
  server.tool(
    "get_qbo_entities",
    "List QuickBooks Online company entities with realm IDs and sync status",
    {},
    async () => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const rows = await db.select().from(qboEntities).orderBy(asc(qboEntities.id));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(rows.map(r => ({
            id: r.id, locationId: r.locationId, realmId: r.realmId,
            companyName: r.companyName, legalName: r.legalName,
            fiscalYearStartMonth: r.fiscalYearStartMonth, syncStatus: r.syncStatus,
            isActive: r.isActive, lastSyncAt: r.lastSyncAt?.toISOString(),
          })), null, 2),
        }],
      };
    }
  );

  // ─── Tool: get_product_sales ───
  server.tool(
    "get_product_sales",
    "Query product-level sales data with quantities and revenue. Useful for menu engineering and food cost analysis.",
    {
      start_date: z.string().describe("Start date YYYY-MM-DD"),
      end_date: z.string().describe("End date YYYY-MM-DD"),
      location_id: z.number().optional().describe("Filter by location ID"),
      category: z.string().optional().describe("Filter by product category"),
      limit: z.number().optional().default(100).describe("Max results"),
    },
    async ({ start_date, end_date, location_id, category, limit }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [
        gte(productSales.saleDate, new Date(start_date)),
        lte(productSales.saleDate, new Date(end_date)),
      ];
      if (location_id) conditions.push(eq(productSales.locationId, location_id));
      if (category) conditions.push(eq(productSales.category, category));

      const rows = await db.select().from(productSales)
        .where(and(...conditions))
        .orderBy(desc(productSales.saleDate))
        .limit(limit || 100);

      const result = rows.map(r => ({
        id: r.id, locationId: r.locationId, saleDate: toDateStr(r.saleDate as any),
        productName: r.productName, category: r.category, quantity: r.quantity,
        grossSales: r.grossSales, netSales: r.netSales, discounts: r.discounts,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, data: result }, null, 2) }] };
    }
  );

  // ─── Tool: get_chart_of_accounts ───
  server.tool(
    "get_chart_of_accounts",
    "Get the cached chart of accounts from QuickBooks Online for a specific entity",
    {
      entity_id: z.number().optional().describe("QBO entity ID. If omitted, returns all cached accounts."),
    },
    async ({ entity_id }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [];
      if (entity_id) conditions.push(eq(qboAccountCache.entityId, entity_id));

      const rows = await db.select().from(qboAccountCache)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(qboAccountCache.accountType), asc(qboAccountCache.name))
        .limit(500);

      const result = rows.map(r => ({
        id: r.id, entityId: r.entityId, qboAccountId: r.qboAccountId,
        name: r.name, accountType: r.accountType, accountSubType: r.accountSubType,
        currentBalance: r.currentBalance, isActive: r.isActive,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify({ count: result.length, data: result }, null, 2) }] };
    }
  );

  // ─── Tool: get_sales_summary ───
  server.tool(
    "get_sales_summary",
    "Get aggregated monthly sales summary for a fiscal year. Useful for trend analysis and KPIs.",
    {
      fiscal_year: z.number().describe("Fiscal year start (e.g., 2025 for Sep 2025 – Aug 2026)"),
      location_id: z.number().optional().describe("Filter by location ID"),
    },
    async ({ fiscal_year, location_id }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const startDate = `${fiscal_year}-09-01`;
      const endDate = `${fiscal_year + 1}-08-31`;

      const conditions: any[] = [
        gte(dailySales.saleDate, new Date(startDate)),
        lte(dailySales.saleDate, new Date(endDate)),
      ];
      if (location_id) conditions.push(eq(dailySales.locationId, location_id));

      const rows = await db.select({
        month: sql<string>`DATE_FORMAT(${dailySales.saleDate}, '%Y-%m')`,
        locationId: dailySales.locationId,
        totalSales: sql<string>`SUM(${dailySales.totalSales})`,
        totalDeposit: sql<string>`SUM(${dailySales.totalDeposit})`,
        totalGst: sql<string>`SUM(${dailySales.gstCollected})`,
        totalQst: sql<string>`SUM(${dailySales.qstCollected})`,
        totalTips: sql<string>`SUM(${dailySales.tipsCollected})`,
        totalLabour: sql<string>`SUM(${dailySales.labourCost})`,
        totalOrders: sql<number>`SUM(${dailySales.orderCount})`,
        dayCount: sql<number>`COUNT(*)`,
      })
        .from(dailySales)
        .where(and(...conditions))
        .groupBy(sql`DATE_FORMAT(${dailySales.saleDate}, '%Y-%m')`, dailySales.locationId)
        .orderBy(sql`DATE_FORMAT(${dailySales.saleDate}, '%Y-%m')`, asc(dailySales.locationId));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            fiscalYear: `${fiscal_year}/${fiscal_year + 1}`,
            period: `${startDate} to ${endDate}`,
            count: rows.length,
            data: rows,
          }, null, 2),
        }],
      };
    }
  );

  // ─── Tool: get_revenue_pipeline_summary ───
  server.tool(
    "get_revenue_pipeline_summary",
    "Get a summary of the revenue journal entry pipeline — counts by status, location, and date range.",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD"),
    },
    async ({ start_date, end_date }) => {
      const db = await getDb();
      if (!db) return { content: [{ type: "text" as const, text: "Database not available" }] };
      const conditions: any[] = [];
      if (start_date) conditions.push(gte(revenueJournalEntries.saleDate, new Date(start_date)));
      if (end_date) conditions.push(lte(revenueJournalEntries.saleDate, new Date(end_date)));

      const rows = await db.select({
        status: revenueJournalEntries.status,
        locationId: revenueJournalEntries.locationId,
        count: sql<number>`COUNT(*)`,
        totalSales: sql<string>`SUM(${revenueJournalEntries.totalSales})`,
      })
        .from(revenueJournalEntries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(revenueJournalEntries.status, revenueJournalEntries.locationId);

      return { content: [{ type: "text" as const, text: JSON.stringify({ data: rows }, null, 2) }] };
    }
  );

  return server;
}

// ─── Register MCP Routes on Express App ───
export function registerMcpRoutes(app: Express): void {
  if (!MCP_SECRET) {
    console.log("[MCP] MCP_SECRET not set — MCP endpoint disabled");
    return;
  }

  // OAuth 2.1 Discovery
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const publicUrl = getPublicUrl(req);
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
  });

  // OAuth 2.1 Authorization Endpoint
  app.get("/oauth/authorize", (req, res) => {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = req.query as Record<string, string>;

    if (response_type !== "code") {
      return res.status(400).json({ error: "unsupported_response_type" });
    }
    if (client_id !== OAUTH_CLIENT_ID) {
      return res.status(400).json({ error: "invalid_client" });
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      return res.status(400).json({ error: "invalid_request", description: "PKCE S256 required" });
    }

    // Auto-approve (machine-to-machine)
    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, {
      code,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(302, redirectUrl.toString());
  });

  // OAuth 2.1 Token Endpoint
  app.post("/oauth/token", (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body;

    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }
    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
      return res.status(401).json({ error: "invalid_client" });
    }

    const authCode = authCodes.get(code);
    if (!authCode || authCode.expiresAt < Date.now()) {
      return res.status(400).json({ error: "invalid_grant", description: "Code expired or invalid" });
    }
    if (authCode.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", description: "redirect_uri mismatch" });
    }

    // Verify PKCE
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(code_verifier || "")
      .digest("base64url");
    if (expectedChallenge !== authCode.codeChallenge) {
      return res.status(400).json({ error: "invalid_grant", description: "PKCE verification failed" });
    }

    authCodes.delete(code);
    const accessToken = crypto.randomBytes(48).toString("hex");
    accessTokens.set(accessToken, {
      token: accessToken,
      clientId: client_id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
    });
  });

  // MCP Streamable HTTP Endpoint — POST
  app.post("/api/mcp", async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;

    try {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on("close", () => {
        transport.close().catch(() => {});
        mcpServer.close().catch(() => {});
      });
    } catch (error: any) {
      console.error("[MCP] Request error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error", message: error.message });
      }
    }
  });

  // MCP Streamable HTTP Endpoint — GET (for SSE / server-initiated notifications)
  app.get("/api/mcp", async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;

    try {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);

      res.on("close", () => {
        transport.close().catch(() => {});
        mcpServer.close().catch(() => {});
      });
    } catch (error: any) {
      console.error("[MCP] GET error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error", message: error.message });
      }
    }
  });

  // MCP Health endpoint
  app.get("/api/mcp/health", (_req, res) => {
    res.json({ status: "ok", server: "hinnawi-ops-accounting-mcp", version: "1.0.0", tools: 11 });
  });

  console.log("[MCP] Streamable HTTP endpoint registered at /api/mcp");
  console.log("[MCP] OAuth discovery at /.well-known/oauth-authorization-server");
}
