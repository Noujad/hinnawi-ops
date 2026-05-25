#!/usr/bin/env node
/**
 * Hinnawi Ops MCP Server — Read-Only Accounting Data
 * 
 * This MCP server exposes read-only tools for querying accounting data
 * from the Hinnawi Ops database (TiDB/MySQL) and QuickBooks Online.
 * 
 * Transport: stdio (for Claude Desktop / Claude coworkers)
 * 
 * Environment variables required:
 *   DATABASE_URL — MySQL/TiDB connection string
 *   QBO_CLIENT_ID — QuickBooks OAuth client ID (optional, for QBO reports)
 *   QBO_CLIENT_SECRET — QuickBooks OAuth client secret (optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, sql, desc, and, gte, lte, asc, between } from "drizzle-orm";
import {
  locations, dailySales, invoices, invoiceLineItems, suppliers,
  payrollRecords, qboEntities, productSales, revenueJournalEntries,
  qboAccountCache, menuItems
} from "../drizzle/schema";

// ─── Database Connection ───
let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is required");
    _db = drizzle(url);
  }
  return _db;
}

// ─── Helper: format date from Date object to YYYY-MM-DD ───
function toDateStr(d: Date | string | null): string {
  if (!d) return "";
  if (typeof d === "string") return d;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ─── Create MCP Server ───
const server = new McpServer({
  name: "hinnawi-ops-accounting",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
  instructions: `Hinnawi Ops Accounting MCP Server — Read-only access to financial data for Bagel & Cafe restaurant chain (4 locations: President Kennedy/PK-MK, Mackay, Cathcart Tunnel, Ontario).

Available data:
- Daily sales (revenue, taxes, tips, deposits, labor costs)
- Revenue journal entries (POS-generated JEs for QuickBooks)
- Invoices and accounts payable
- Suppliers/vendors
- Payroll records
- Product-level sales with food cost analysis
- QuickBooks Online entity information
- Chart of accounts from QBO

All monetary values are in CAD. Fiscal year runs Sep 1 – Aug 31.
Ontario location is in Quebec (charges GST 5% + QST 9.975%).`,
});

// ─── Tool: get_locations ───
server.tool(
  "get_locations",
  "List all cafe locations with their codes, names, and targets",
  {},
  async () => {
    const db = getDb();
    const rows = await db.select().from(locations).orderBy(asc(locations.id));
    return {
      content: [{
        type: "text",
        text: JSON.stringify(rows.map(r => ({
          id: r.id,
          code: r.code,
          name: r.name,
          entityName: r.entityName,
          address: r.address,
          laborTarget: r.laborTarget,
          foodCostTarget: r.foodCostTarget,
          isActive: r.isActive,
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
    const db = getDb();
    const conditions = [
      gte(dailySales.saleDate, new Date(start_date)),
      lte(dailySales.saleDate, new Date(end_date)),
    ];
    if (location_id) conditions.push(eq(dailySales.locationId, location_id));

    const rows = await db.select().from(dailySales)
      .where(and(...conditions))
      .orderBy(desc(dailySales.saleDate), asc(dailySales.locationId))
      .limit(500);

    const result = rows.map(r => ({
      id: r.id,
      locationId: r.locationId,
      saleDate: toDateStr(r.saleDate),
      totalSales: r.totalSales,
      taxExemptSales: r.taxExemptSales,
      taxableSales: r.taxableSales,
      gstCollected: r.gstCollected,
      qstCollected: r.qstCollected,
      totalDeposit: r.totalDeposit,
      tipsCollected: r.tipsCollected,
      merchantFees: r.merchantFees,
      pettyCash: r.pettyCash,
      discounts: r.discounts,
      labourCost: r.labourCost,
      orderCount: r.orderCount,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: result.length, data: result }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_revenue_journal_entries ───
server.tool(
  "get_revenue_journal_entries",
  "Query revenue journal entries from the POS pipeline. Filter by status, location, date range. Shows JE details including line items.",
  {
    status: z.enum(["posted", "voided", "deleted", "failed", "pending"]).optional().describe("Filter by JE status"),
    location_id: z.number().optional().describe("Filter by location ID"),
    start_date: z.string().optional().describe("Start date YYYY-MM-DD"),
    end_date: z.string().optional().describe("End date YYYY-MM-DD"),
    limit: z.number().optional().default(100).describe("Max results (default 100)"),
  },
  async ({ status, location_id, start_date, end_date, limit }) => {
    const db = getDb();
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
      id: r.id,
      locationId: r.locationId,
      saleDate: toDateStr(r.saleDate),
      realmId: r.realmId,
      docNumber: r.docNumber,
      status: r.status,
      totalSales: r.totalSales,
      netRevenue: r.netRevenue,
      gst: r.gst,
      qst: r.qst,
      taxExemptSales: r.taxExemptSales,
      taxableSales: r.taxableSales,
      tips: r.tips,
      pettyCash: r.pettyCash,
      arAmount: r.arAmount,
      roundingAdj: r.roundingAdj,
      qboJeId: r.qboJeId,
      errorMessage: r.errorMessage,
      postedAt: r.postedAt?.toISOString(),
      jeLineDetails: r.jeLineDetails,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: result.length, data: result }, null, 2),
      }],
    };
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
    const db = getDb();
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
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      supplierId: r.supplierId,
      locationId: r.locationId,
      invoiceDate: toDateStr(r.invoiceDate),
      dueDate: toDateStr(r.dueDate),
      subtotal: r.subtotal,
      gst: r.gst,
      qst: r.qst,
      total: r.total,
      status: r.status,
      glAccount: r.glAccount,
      qboSynced: r.qboSynced,
      qboSyncStatus: r.qboSyncStatus,
      notes: r.notes,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: result.length, data: result }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_suppliers ───
server.tool(
  "get_suppliers",
  "List all vendors/suppliers",
  {},
  async () => {
    const db = getDb();
    const rows = await db.select().from(suppliers).orderBy(asc(suppliers.name));
    return {
      content: [{
        type: "text",
        text: JSON.stringify(rows.map(r => ({
          id: r.id,
          name: r.name,
          category: r.category,
          contactName: r.contactName,
          email: r.email,
          phone: r.phone,
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
    const db = getDb();
    const conditions = [
      gte(payrollRecords.weekEnding, new Date(start_date)),
      lte(payrollRecords.weekEnding, new Date(end_date)),
    ];
    if (location_id) conditions.push(eq(payrollRecords.locationId, location_id));

    const rows = await db.select().from(payrollRecords)
      .where(and(...conditions))
      .orderBy(desc(payrollRecords.weekEnding))
      .limit(200);

    const result = rows.map(r => ({
      id: r.id,
      locationId: r.locationId,
      weekEnding: toDateStr(r.weekEnding),
      totalHours: r.totalHours,
      totalWages: r.totalWages,
      employeeCount: r.employeeCount,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: result.length, data: result }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_qbo_entities ───
server.tool(
  "get_qbo_entities",
  "List QuickBooks Online company entities with realm IDs and sync status",
  {},
  async () => {
    const db = getDb();
    const rows = await db.select().from(qboEntities).orderBy(asc(qboEntities.id));
    return {
      content: [{
        type: "text",
        text: JSON.stringify(rows.map(r => ({
          id: r.id,
          locationId: r.locationId,
          realmId: r.realmId,
          companyName: r.companyName,
          legalName: r.legalName,
          fiscalYearStartMonth: r.fiscalYearStartMonth,
          syncStatus: r.syncStatus,
          isActive: r.isActive,
          lastSyncAt: r.lastSyncAt?.toISOString(),
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
    const db = getDb();
    const conditions = [
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
      id: r.id,
      locationId: r.locationId,
      saleDate: toDateStr(r.saleDate),
      productName: r.productName,
      category: r.category,
      quantity: r.quantity,
      grossSales: r.grossSales,
      netSales: r.netSales,
      discounts: r.discounts,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: result.length, data: result }, null, 2),
      }],
    };
  }
);

// ─── Tool: get_chart_of_accounts ───
server.tool(
  "get_chart_of_accounts",
  "Get the cached chart of accounts from QuickBooks Online for a specific entity",
  {
    entity_id: z.number().optional().describe("QBO entity ID (from get_qbo_entities). If omitted, returns all cached accounts."),
  },
  async ({ entity_id }) => {
    const db = getDb();
    const conditions: any[] = [];
    if (entity_id) conditions.push(eq(qboAccountCache.entityId, entity_id));

    const rows = await db.select().from(qboAccountCache)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(qboAccountCache.accountType), asc(qboAccountCache.name))
      .limit(500);

    const result = rows.map(r => ({
      id: r.id,
      entityId: r.entityId,
      qboAccountId: r.qboAccountId,
      name: r.name,
      accountType: r.accountType,
      accountSubType: r.accountSubType,
      currentBalance: r.currentBalance,
      isActive: r.isActive,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: result.length, data: result }, null, 2),
      }],
    };
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
    const db = getDb();
    const startDate = `${fiscal_year}-09-01`;
    const endDate = `${fiscal_year + 1}-08-31`;

    const conditions = [
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
        type: "text",
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
    const db = getDb();
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

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ data: rows }, null, 2),
      }],
    };
  }
);

// ─── Start Server ───
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Hinnawi Ops MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
