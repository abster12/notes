# Glossary

Canonical terms for this workspace. Once a term is here, use it consistently in every article and lesson.

## Architecture

| Term | Definition |
|---|---|
| **Orchestrator** | The LLM-driven agent that classifies intent, decides which tools to call, and synthesizes the final answer. Not the same as the conversation agent — the orchestrator runs the workflow, the conversation agent is the user-facing voice. (In this design they are the same.) |
| **Tool** | A deterministic, schema-validated function exposed to the orchestrator. The LLM does not generate values for tools; it generates parameters and interprets results. |
| **MCP** | Model Context Protocol. A standard for exposing tools/data sources to LLM agents. Replaces bespoke tool APIs with a discoverable, schema-typed interface. |
| **Brief** | A precomputed, time-bounded summary of context (positions, exposure, recent news) that the PM sees every morning. NOT a cache in the systems sense — it has a refresh cadence, not a TTL. |
| **Critic agent** | A second LLM call (possibly different model) that reviews the orchestrator's synthesized answer against the original query and tool outputs. Defends against hallucination. |
| **As-of timestamp** | The wall-clock time at which a piece of data was observed. Every number has one. Critical for stale-data detection. |

## Hedge-fund domain

| Term | Definition |
|---|---|
| **PM** | Portfolio Manager. The end user. Non-technical, makes position decisions based on the agent's output. |
| **AUM** | Assets Under Management. The fund's total capital. $4B AUM is a mid-sized fund. |
| **Long/short equity** | A fund strategy: takes long positions in stocks it expects to rise, short positions in stocks it expects to fall. |
| **Pre-market prep** | The morning ritual: PM checks positions, overnight moves, news, calendar. The agent's primary use case. |
| **FOMC** | Federal Open Market Committee. Sets US interest rate policy. Meetings drive market volatility. |

## Multi-tenancy

| Term | Definition |
|---|---|
| **Tenant** | A single hedge fund client. Multi-tenant = many funds on shared infra. |
| **Tenant isolation** | The property that tenant A's data, prompts, audit logs, and cost are never visible to or commingled with tenant B's. Enforced at every layer: network, data, compute, audit, prompt. |
| **Cross-tenant prompt injection** | A malicious PM at tenant A crafts a prompt that tricks the agent into revealing tenant B's data. The most underrated threat in multi-tenant LLM systems. |
| **Compliance officer UI** | A separate user interface for the tenant's compliance team. Searches audit logs, runs subpoena queries, sees anomaly detection. Different product surface than the PM UI. |

## Data layer

| Term | Definition |
|---|---|
| **Market data feed** | Real-time or delayed price feed from a vendor (refinitiv, bloomberg, polygon, IEX). Subject to delay, gaps, vendor outages. |
| **OLAP** | Online Analytical Processing. Optimized for aggregate queries across many rows. ClickHouse, DuckDB, Snowflake, BigQuery. |
| **Idempotent load** | An ETL operation where replaying produces the same state. Primary key + as-of timestamp. |
| **Late-arriving data** | Market data that arrives after the wall-clock timestamp it represents. Common in real-time feeds. Handled with backfill windows and reconciliation. |
| **Lineage** | The chain from a number in the agent's response back to the source feed and the timestamp it was observed. Required for compliance. |
