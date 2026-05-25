# Hinnawi Ops MCP Server — Read-Only Accounting Data

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude coworkers read-only access to the Hinnawi Ops accounting database.

## Available Tools (11)

| Tool | Description |
|------|-------------|
| `get_locations` | List all cafe locations with codes, names, and targets |
| `get_daily_sales` | Query daily sales by date range and/or location |
| `get_revenue_journal_entries` | Query revenue JEs with status/location/date filters |
| `get_invoices` | List AP invoices with status/supplier/location filters |
| `get_suppliers` | List all vendors/suppliers |
| `get_payroll` | Query payroll records by date range and/or location |
| `get_qbo_entities` | List QuickBooks Online entities with realm IDs |
| `get_product_sales` | Product-level sales data for menu engineering |
| `get_chart_of_accounts` | Cached QBO chart of accounts |
| `get_sales_summary` | Aggregated monthly sales for a fiscal year |
| `get_revenue_pipeline_summary` | Revenue JE pipeline status counts |

## Setup

### Prerequisites

- Node.js 20+
- Access to the Hinnawi Ops TiDB/MySQL database (DATABASE_URL)

### Build

```bash
cd ~/hinnawi-ops
pnpm install
node mcp-server/build.mjs
```

### Configure for Claude Desktop

Add this to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hinnawi-ops": {
      "command": "node",
      "args": ["/path/to/hinnawi-ops/mcp-server/dist/index.mjs"],
      "env": {
        "DATABASE_URL": "mysql://user:password@host:port/database?ssl={\"rejectUnauthorized\":true}"
      }
    }
  }
}
```

Replace `/path/to/hinnawi-ops` with the actual path to your cloned repo, and set the `DATABASE_URL` to your TiDB/MySQL connection string.

### Configure for Claude Coworker (Anthropic API)

If using via the Anthropic API with MCP support:

```python
import anthropic

client = anthropic.Anthropic()

# The MCP server runs as a subprocess
response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    mcp_servers=[{
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/hinnawi-ops/mcp-server/dist/index.mjs"],
        "env": {
            "DATABASE_URL": "your-database-url"
        }
    }],
    messages=[{"role": "user", "content": "Show me yesterday's sales for all locations"}]
)
```

## Security

- **Read-only**: No write operations are exposed. The server cannot modify any data.
- **Database**: Uses the same TiDB connection as the main app. Ensure the DATABASE_URL user has only SELECT privileges if you want extra safety.
- **No QBO API calls**: The server only reads cached data from the local database. It does not make live API calls to QuickBooks Online.

## Example Queries

Once connected, your Claude coworker can answer questions like:

- "What were total sales for all locations last week?"
- "Show me all failed revenue journal entries for Ontario"
- "List all pending invoices over $500"
- "What's the payroll cost trend for Mackay over the last 3 months?"
- "Which products have the highest sales volume at President Kennedy?"
- "Give me a monthly sales summary for fiscal year 2024/2025"
