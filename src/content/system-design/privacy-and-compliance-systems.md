---
title: "Privacy & Compliance Systems (PII, GDPR, Audit, Data Residency)"
type: system-design
category: Platform
date: 2026-06-11
tags: [system-design, interview, platform, privacy, gdpr, pii, compliance, data-residency, audit, encryption, tokenization, consent-management, right-to-erasure]
aliases: ["Privacy & Compliance Systems", "GDPR Architecture", "Data Residency Architecture", "PII Management Systems", "Compliance Engineering"]
---

# Privacy & Compliance Systems (PII, GDPR, Audit, Data Residency)

> **Staff-Engineer Focus:** Encrypting a column in a database is a mid-level task. Building a privacy platform that can retroactively delete a user's data across 50+ microservices, 5 data stores, 3 analytics pipelines, and ML training datasets — within the 30-day GDPR window, while producing an auditor-ready proof of deletion, without breaking the product or violating any of the 7 overlapping regulatory regimes your company operates under — that's a staff engineer problem. The interview question isn't "explain GDPR" — it's "your company is launching in the EU. The legal team just told you that 3 years of user data is scattered across 80 services with no PII classification, no consent tracking, and no deletion mechanism. The CPO wants a plan by Friday. What do you build?"

---

## Summary & Interview Framing

A system that classifies PII, enforces data residency, manages consent, and handles GDPR right-to-erasure across all services, databases, backups, and ML training sets.

**How it's asked:** "Your company is launching in the EU. Design a privacy platform that handles PII classification, consent management, right-to-erasure across 80 services, and audit trails."

---

## 1. What Problem Does a Privacy & Compliance System Solve?

At its core, privacy engineering answers one question: **how do you use data to power your product while respecting the rights of the people that data belongs to — and prove it to regulators?**

But at the staff level, the real question is deeper: **how do you embed privacy into the platform itself, so that every new service gets compliance for free — instead of each team building their own half-baked GDPR implementation that creates 80 different ways to fail an audit?**

### The Regulatory Landscape (What You're Actually Building Against)

| Regulation | Jurisdiction | Key Requirement | Technical Implication |
|-----------|-------------|----------------|----------------------|
| **GDPR** | EU/EEA | Right to access, rectify, erase, port data. Consent must be explicit, withdrawable. Breach notification within 72 hours. Data Protection Officer required. | Hard deletion of all user data within 30 days. Audit trail of who touched what data and why. Data export in machine-readable format. |
| **CCPA/CPRA** | California, USA | Right to know what's collected, opt-out of sale, delete data. | Similar to GDPR delete, but narrower "sale" definition. Opt-out signal (GPC) must be respected. |
| **LGPD** | Brazil | Brazilian GDPR. Similar requirements. | Near-identical to GDPR with some local nuances. |
| **PIPEDA** | Canada | Consent-based collection, accuracy, safeguard requirements. | Data must be accurate and protected with "appropriate" safeguards. |
| **HIPAA** | USA (healthcare) | Protected Health Information (PHI) safeguards. Minimum necessary use. Audit controls. | BAAs (Business Associate Agreements), de-identification standards (Safe Harbor vs Expert Determination). |
| **PCI DSS** | Global (payments) | Cardholder data protection. Encryption at rest. Access control. | Never store CVV. PAN must be rendered unreadable (tokenization, truncation, or strong encryption). |
| **Data Residency** | Various (EU, Russia, China, India) | Data about citizens must stay within national borders. | Geo-fenced infrastructure. Cross-region data flow maps. Data transfer impact assessments (TIAs). |

**The unifying pattern:** Every regulation demands three things: **know what data you have** (discovery/classification), **control who accesses it** (governance), and **delete it on request** (lifecycle). Build your platform around these three pillars.

### The Compliance Maturity Model

| Level | Name | Characteristics | What Breaks |
|-------|------|---------------|-------------|
| **L0 — Ad-hoc** | Spreadsheets and hope | No data inventory. Manual deletion (engineer runs SQL). | Every DSAR takes 3 weeks and still misses data. |
| **L1 — Point Solutions** | One-off scripts per service | Each team builds their own GDPR delete endpoint. No consistency. | Delete request succeeds in 5 services, fails in 7, nobody knows. |
| **L2 — Platform** | Centralized data catalog + deletion orchestration | PII classified automatically. Deletion fan-out with retry and audit. | Cross-service dependencies create complex orchestration. |
| **L3 — Privacy-by-Design** | Privacy is a platform primitive | New services inherit compliance automatically. Privacy is a compile-time check. | The platform team becomes the bottleneck for data model changes. |
| **L4 — Continuous Compliance** | Automated evidence collection + real-time audit readiness | Regulators can query compliance state via API. | Practically nobody is here yet. This is the frontier. |

**Interview heuristic:** Most companies are at L0 or L1. A staff engineer should describe L2 and explain what it takes to reach L3. Mentioning L4 shows you understand where the industry is heading.

---

## 2. The Three Pillars: Discovery → Governance → Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PRIVACY PLATFORM ARCHITECTURE                     │
│                                                                      │
│  ┌─────────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │  PILLAR 1:           │  │  PILLAR 2:        │  │  PILLAR 3:     │  │
│  │  DATA DISCOVERY      │→ │  DATA GOVERNANCE  │→ │  DATA LIFECYCLE │  │
│  │                      │  │                    │  │                │  │
│  │  • PII Classification│  │  • Access Control  │  │  • Deletion    │  │
│  │  • Data Flow Mapping │  │  • Consent Mgmt    │  │  • Anonymization│  │
│  │  • Data Catalog      │  │  • Purpose Binding │  │  • Retention   │  │
│  │  • Sensitive Data    │  │  • Data Residency  │  │  • Audit Trail │  │
│  │    Scanner           │  │  • Policy Engine   │  │  • DSAR Handler│  │
│  └─────────┬───────────┘  └────────┬─────────┘  └───────┬────────┘  │
│            │                       │                     │           │
│            ▼                       ▼                     ▼           │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                   SHARED INFRASTRUCTURE                          │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │ │
│  │  │ Encryption   │  │ Tokenization │  │ Audit Log           │   │ │
│  │  │ (KMS/TLS/    │  │ (Vault/      │  │ (Immutable,         │   │ │
│  │  │  Envelope)   │  │  Gateway)    │  │  Tamper-proof)      │   │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Pillar 1 — Data Discovery & Classification

You can't protect what you don't know you have. The first pillar answers: **where is PII in our systems?**

### PII Classification Tiers

| Tier | Name | Examples | Storage Rules | Access Rules |
|------|------|----------|--------------|-------------|
| **T0** | Public | Product catalog, blog posts, open-source code | No restrictions | No restrictions |
| **T1** | Internal | Internal dashboards, error logs (de-identified), aggregate metrics | Access logging recommended | Employee access only |
| **T2** | Sensitive PII | Email, name, phone, address, IP address | Encrypted at rest. Access logged. | Role-based. Break-glass for production access. |
| **T3** | Highly Sensitive | Government ID, passport, SSN, payment info, precise geolocation, health data | Encrypted at rest AND application-layer encrypted. Tokenization where possible. | Least-privilege. All access requires approval. |
| **T4** | Toxic / Prohibited | CVV, full credit card magstripe, biometric raw data, passwords in plaintext | **Must never be stored.** | N/A — if it exists, it's an incident. |

### Automated PII Detection

**Rule-based scanning (what to build first):**

| Detector | Pattern | Confidence | False Positive Risk |
|----------|---------|-----------|---------------------|
| Email | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | High | Low |
| Credit Card | Luhn algorithm check | High | Moderate (16-digit IDs trigger it) |
| SSN (US) | `\d{3}-\d{2}-\d{4}` | Medium | High (many 9-digit strings match) |
| Phone | Various country-specific regexes | Medium | High (dates, IDs, codes match) |
| IP Address | Regex + valid range check | High | Low |
| Free-text PII | ML-based NER (spaCy, Presidio) | Medium-Low | High (requires context) |

**Architecture for PII scanning:**

```
┌──────────┐     ┌────────────────┐     ┌──────────────┐
│  Schema  │     │  Data Scanner   │     │  Data Catalog │
│  Crawler │────→│  (per-source)   │────→│  (Collibra/   │
│  (DB      │     │  ┌──────────┐  │     │   Amundsen/   │
│   schemas,│     │  │ Column    │  │     │   DataHub)    │
│   S3      │     │  │ Scanner   │  │     │               │
│   paths)  │     │  │ (regex +  │  │     │  • PII tags   │
│           │     │  │  stats)   │  │     │  • Lineage    │
│           │     │  └──────────┘  │     │  • Ownership   │
│           │     │  ┌──────────┐  │     │               │
│           │     │  │ Value     │  │     │               │
│           │     │  │ Sampler   │  │     │               │
│           │     │  │ (scan     │  │     │               │
│           │     │  │  actual   │  │     │               │
│           │     │  │  values)  │  │     │               │
│           │     │  └──────────┘  │     │               │
│           │     └────────────────┘     └───────────────┘
└──────────┘
```

**The scanning strategy:** Column scanner checks column names and types (fast, covers 80%). Value sampler reads a sample of actual data (slower, catches the other 20%, like an `external_id` column that actually has emails in it).

**The critical interview point:** PII classification is never done. New columns are created daily. Data changes. ML models create derived features that inadvertently contain PII. The scanner must run continuously — not as a one-time project. Schedule it as a recurring job with alerting on new unclassified columns.

---

## 4. Pillar 2 — Data Governance

Once you know where PII lives, governance controls **who can access it, for what purpose, with what consent.**

### Consent Management at Scale

GDPR requires **explicit, granular, withdrawable consent**. Here's what that means architecturally:

```
┌─────────────────────────────────────────────────────────────┐
│                   CONSENT MANAGEMENT                         │
│                                                              │
│  User grants consent:                                        │
│  "I agree to marketing emails"                               │
│  "I agree to analytics cookies"                              │
│  "I agree to personalized recommendations"                   │
│         │                                                    │
│         ▼                                                    │
│  ┌────────────────┐     ┌────────────────┐                  │
│  │  Consent Store │────→│  Policy Engine │                  │
│  │  (immutable    │     │  (OPA/Cedar/   │                  │
│  │   append-only) │     │   custom)      │                  │
│  │                │     │                │                  │
│  │  user_id: 42   │     │  "Can service │                  │
│  │  purpose:      │     │   X access     │                  │
│  │    marketing   │     │   user 42 for  │                  │
│  │  status:       │     │   marketing?"  │                  │
│  │    granted     │     │   → Check      │                  │
│  │  timestamp:    │     │   consent      │                  │
│  │    2025-01-01  │     │   store → YES  │                  │
│  │  proof:        │     └────────────────┘                  │
│  │    ip, session │                                         │
│  └────────────────┘                                         │
└─────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

1. **Consent store must be immutable**: You must be able to prove what consent existed at any point in time. Append-only ledger. Never update — always append a new version. This is similar to event sourcing.

2. **Consent propagation latency**: When a user withdraws consent, how fast does it take effect? For marketing emails: hours is fine. For data sharing: seconds. Design your consent cache TTL accordingly.

3. **Granularity spectrum**: Single on/off toggle → per-purpose → per-purpose-per-vendor → per-purpose-per-vendor-per-data-category. More granularity = more user trust + more implementation complexity. Weigh the trade-off.

### Policy as Code (OPA / Cedar)

Instead of hardcoding authorization logic in every service, use a policy engine:

```rego
# OPA (Rego) policy example
package privacy

default allow = false

allow {
    input.purpose == "marketing"
    consent[input.user_id].marketing == true
    input.data_tier in {"T0", "T1", "T2"}
}

allow {
    input.purpose == "analytics"
    consent[input.user_id].analytics == true
    input.anonymized == true
}

# Explicit deny for T3/T4
deny {
    input.data_tier in {"T3", "T4"}
    input.purpose == "analytics"
}
```

The policy engine decouples compliance rules from application code. When GDPR updates or a new regulation (e.g., India's DPDP Act) comes into effect, you update the policy — not 50 services.

### Data Residency Architecture

Data residency means: EU user data must stay in EU data centers. Here's how to enforce it:

```
                    ┌───────────────────────┐
    EU User ───────→│  EU Region (Frankfurt) │
                    │  ┌─────────────────┐  │
                    │  │ Application     │  │
                    │  │ (EU-only data)  │  │
                    │  └────────┬────────┘  │
                    │           │           │
                    │  ┌────────▼────────┐  │
                    │  │ EU Data Stores  │  │
                    │  │ (DynamoDB/S3)   │  │
                    │  └─────────────────┘  │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Cross-Region Gateway │
                    │  ┌─────────────────┐  │
                    │  │ Residency Filter│  │
                    │  │ (blocks PII     │  │
                    │  │  from leaving   │  │
                    │  │  EU region)     │  │
                    │  └─────────────────┘  │
                    └───────────┬───────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
    ┌─────────▼──────┐  ┌──────▼──────┐  ┌───────▼────────┐
    │ US Region      │  │ APAC Region │  │ Global Services │
    │ (de-identified │  │ (de-ID'd)   │  │ (aggregated     │
    │  data only)    │  │             │  │  metrics only)  │
    └────────────────┘  └─────────────┘  └────────────────┘
```

**Architecture patterns for data residency:**

| Pattern | How It Works | Pros | Cons |
|---------|-------------|------|------|
| **Cell-based** | Each region is a fully independent stack. No cross-region data flow. | Cleanest guarantee. Full isolation. | Expensive. Duplicated infra. Regions can't share data even anonymized. |
| **Gateway-filtered** | Single global app, but a residency gateway blocks PII from leaving its home region. | Cheaper. Shared codebase. | Gateway becomes bottleneck and single point of compliance failure. |
| **Shard-per-region** | Data is partitioned by user region. EU users hit EU shard. US users hit US shard. | Good balance of cost and compliance. | Cross-shard queries (e.g., "users followed by EU and US users") become complex. |
| **Differential privacy** | Add calibrated noise to data before it leaves the region. ε-differential privacy guarantee. | Allows safe cross-region analytics. | Loss of precision. Challenging to implement correctly. |

**The shard-per-region pattern is the modern default.** It balances cost and compliance: EU data stays in EU, but you don't need 5 completely separate stacks.

---

## 5. Pillar 3 — Data Lifecycle (The Right to Erasure)

GDPR Article 17: users have the right to request deletion of their data. You have 30 days. **This is the hardest part of compliance engineering.**

### The Deletion Problem

User data isn't in one place. It's in:

- **Online serving databases** (Postgres, DynamoDB, Cassandra)
- **Search indexes** (Elasticsearch, Algolia)
- **Caches** (Redis, Memcached, CDN edge caches)
- **Analytics data warehouses** (Snowflake, BigQuery, Iceberg)
- **Message queues** (Kafka topics with retention)
- **Object storage** (S3, GCS — raw logs, Parquet files, backups)
- **ML training datasets** (Feature stores, training data snapshots)
- **Third-party services** (analytics, CRM, email delivery, push notifications)
- **Database backups** (Point-in-time recovery snapshots)
- **Audit logs** (which, ironically, record that you accessed the data)

### The Orchestrated Deletion Pattern

```
┌───────────────────────────────────────────────────────────────┐
│                    DELETION ORCHESTRATOR                        │
│                                                                 │
│  DSAR Request (GDPR Art. 17)                                    │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────────┐                                           │
│  │ 1. Locate Data   │  ← Data Catalog (where is user 42?)      │
│  │    (fan-out      │                                           │
│  │     query)       │                                           │
│  └────────┬────────┘                                           │
│           ▼                                                     │
│  ┌─────────────────┐     ┌──────────────────────────┐         │
│  │ 2. Soft Delete   │────→│  • Set deleted_at flag    │         │
│  │    (immediate)   │     │  • Remove from search     │         │
│  │                  │     │  • Block all access       │         │
│  └────────┬────────┘     └──────────────────────────┘         │
│           ▼                                                     │
│  ┌─────────────────┐     ┌──────────────────────────┐         │
│  │ 3. Hard Delete   │────→│  • Delete from DB, S3,    │         │
│  │    (30-day SLA)  │     │    Kafka, caches, backups │         │
│  │                  │     │  • Retry with backoff     │         │
│  │                  │     │  • DLQ for failures       │         │
│  └────────┬────────┘     └──────────────────────────┘         │
│           ▼                                                     │
│  ┌─────────────────┐     ┌──────────────────────────┐         │
│  │ 4. Verify        │────→│  • Probe each data store  │         │
│  │    (proof)       │     │  • "Does user 42 exist?"  │         │
│  │                  │     │  • If yes → escalate      │         │
│  └────────┬────────┘     └──────────────────────────┘         │
│           ▼                                                     │
│  ┌─────────────────┐                                           │
│  │ 5. Certificate   │  ← Immutable deletion certificate        │
│  │    of Deletion   │     (auditor-ready proof)                │
│  └─────────────────┘                                           │
└───────────────────────────────────────────────────────────────┘
```

### The Backup Problem (The Hardest One)

You can delete user data from your live database. But what about the backup from 3 months ago that contains their data? Restoring that backup brings their data back — a GDPR violation.

**Solutions:**

| Approach | How It Works | Trade-off |
|----------|-------------|-----------|
| **Purge backups** | After deletion, re-process all backups to remove the user's data. | Expensive. Makes backup restoration slow. May break backup integrity. |
| **Backup tombstone** | Add the deleted user's ID to a "tombstone set." On restore, replay all tombstones against the restored data. | Restore = wait for tombstone replay. Tombstone set grows forever. |
| **Logical backups only** | Don't take raw disk snapshots. Export logical backups (SQL dumps) that can be filtered during restore. | Much slower backup and restore. Not practical at scale. |
| **Crypto-shredding** | Encrypt each user's data with a per-user key. Delete = destroy the key. Backups become unreadable garbage. | Most elegant. But requires key-per-user encryption at the application layer. |

**Crypto-shredding is the staff-engineer answer.** It makes deletion a key management operation — delete the key, and all data (including backups, including data that's been replicated across regions) becomes permanently unreadable. The trade-off is operational: you now manage millions of encryption keys and must never lose the key store.

### The Anonymization Spectrum

Sometimes you don't want to delete data — you want to keep it for analytics but remove PII:

| Technique | What It Does | Re-identification Risk | Example |
|-----------|-------------|----------------------|---------|
| **Pseudonymization** | Replace PII with a reversible token | High (if you have the mapping table) | `john@email.com` → `user_7a3f` |
| **Tokenization** | Replace PII with a non-reversible token (vaulted) | Medium (vault holds mapping) | Credit card → `tok_abc123` |
| **K-anonymity** | Generalize data so each record is indistinguishable from k-1 others | Low-Medium | Age 37 → Age 30-40 |
| **Differential Privacy** | Add calibrated noise (ε parameter) | Very Low (provable guarantee) | Count = real count + Laplace noise |
| **Full Anonymization** | Irreversibly destroy all identifiers | None (data is no longer personal) | Delete name, email, IP. Keep only aggregates. |

---

## 6. Encryption Architecture

### The Encryption Hierarchy

```
┌──────────────────────────────────────────────────────────────┐
│                    ENCRYPTION LAYERS                           │
│                                                                │
│  Layer 4: Application-Layer Encryption (ALE)                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Encrypt PII BEFORE it hits the database             │    │
│  │  • Per-field encryption: email_encrypted, name_encrypted│  │
│  │  • Per-user keys (enables crypto-shredding)           │    │
│  │  • Application holds keys, DB never sees plaintext    │    │
│  │  • Trade-off: no DB-level search, sort, or index      │    │
│  └──────────────────────────────────────────────────────┘    │
│                           ▲                                    │
│  Layer 3: Envelope Encryption (KMS + DEKs)                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  AWS KMS / GCP Cloud KMS / HashiCorp Vault            │    │
│  │  • Customer Master Key (CMK) never leaves KMS         │    │
│  │  • Data Encryption Keys (DEKs) generated per-resource │    │
│  │  • DEK encrypted by CMK, stored alongside data        │    │
│  │  • Rotation: re-wrap DEKs with new CMK (no re-encrypt)│    │
│  └──────────────────────────────────────────────────────┘    │
│                           ▲                                    │
│  Layer 2: Transport Encryption (TLS/mTLS)                     │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  All service-to-service comms encrypted in transit    │    │
│  │  • mTLS in service mesh (Istio/Linkerd)               │    │
│  │  • Certificate rotation via cert-manager              │    │
│  └──────────────────────────────────────────────────────┘    │
│                           ▲                                    │
│  Layer 1: Storage Encryption (at rest)                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Disk-level encryption (AES-256)                      │    │
│  │  • EBS encryption, S3 SSE-KMS, RDS encryption        │    │
│  │  • Protects against physical disk theft               │    │
│  │  • Does NOT protect against app-level access          │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**The encryption fallacy:** "We encrypt data at rest, so we're compliant." No. Encryption at rest (Layer 1) protects against someone stealing a physical disk. It does nothing against an attacker who compromises your application, an engineer who runs a production query, or a data pipeline that accidentally copies PII to an unencrypted analytics table. For true compliance, you need Application-Layer Encryption (Layer 4) for T3/T4 data.

### When to Use Tokenization vs Encryption

| Concern | Encryption | Tokenization (Vault) |
|---------|-----------|----------------------|
| **Reversibility** | Reversible with key | Reversible via vault lookup |
| **Format preservation** | Ciphertext looks random | Token can preserve format (e.g., last 4 digits) |
| **Searchability** | Cannot search/index ciphertext | Can index on token (token is deterministic) |
| **Key management** | Must protect encryption keys | Must protect vault + vault access |
| **PCI compliance** | Requires key management audit | Reduces PCI scope (no cardholder data in your systems) |
| **Performance** | Fast (local crypto operation) | Slower (network call to vault per operation) |
| **Best for** | Data at rest, backups, internal data | Credit cards, SSNs, data you reference but rarely read full value of |

**The rule:** Tokenize credit cards (PCI scope reduction). Encrypt everything else (operational simplicity).

---

## 7. Audit Logging — The Proof Layer

Compliance without audit is just trust. Regulators want **proof.** Your audit system must be:

### Audit Log Requirements

```
┌─────────────────────────────────────────────────────────────┐
│                  AUDIT LOG ARCHITECTURE                       │
│                                                               │
│  ┌─────────────────┐     ┌──────────────────┐               │
│  │  Service Layer   │────→│  Audit Sidecar   │               │
│  │  (emits events)  │     │  (async, non-    │               │
│  │                  │     │   blocking)      │               │
│  └─────────────────┘     └────────┬─────────┘               │
│                                   │                          │
│                      ┌────────────▼──────────┐              │
│                      │  Audit Event Schema    │              │
│                      │  ┌──────────────────┐ │              │
│                      │  │ • who (principal) │ │              │
│                      │  │ • what (resource) │ │              │
│                      │  │ • when (timestamp)│ │              │
│                      │  │ • why (purpose)   │ │              │
│                      │  │ • how (method)    │ │              │
│                      │  │ • result (allow/  │ │              │
│                      │  │   deny)           │ │              │
│                      │  │ • data_class      │ │              │
│                      │  └──────────────────┘ │              │
│                      └────────────┬──────────┘              │
│                                   │                          │
│              ┌────────────────────┼──────────────────┐      │
│              ▼                    ▼                    ▼      │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐ │
│  │ Hot Storage    │    │ Warm Storage  │    │ Cold Storage  │ │
│  │ (Elasticsearch)│───→│ (S3/Parquet)  │───→│ (Glacier)     │ │
│  │ Last 30 days   │    │ 30 days-1 yr  │    │ 1-7 years     │ │
│  │ Real-time      │    │ Batch queries │    │ Compliance    │ │
│  │ search/alerts  │    │ via Athena    │    │ retention     │ │
│  └───────────────┘    └───────────────┘    └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Immutability is non-negotiable:** Once written, an audit log entry must never be modified. Use S3 Object Lock (WORM — Write Once Read Many) or append-only ledger (like QLDB / Amazon Aurora with temporal tables). An audit log that can be altered is worse than no audit log — it creates false confidence.

**What to log (the minimum):**

| Event | Data Points | Retention |
|-------|------------|-----------|
| Data access (read) | Who, what resource, what fields, timestamp, purpose | 1-7 years (jurisdiction-dependent) |
| Data modification | Old value, new value, who, timestamp | Same as data retention |
| Consent change | User, old consent state, new consent state, proof (IP, session), timestamp | Forever (must prove consent history) |
| Deletion | What was deleted, who requested, timestamp, verification result | Forever (proof of compliance) |
| Permission change | Who changed what permission for whom, timestamp | 1-7 years |
| Key access (KMS) | Which key, which principal, timestamp | 1-7 years |

---

## 8. DSAR (Data Subject Access Request) Pipeline

Users have 30 days to get a response. For a company with millions of users, handling DSARs at scale requires automation.

```
User submits DSAR (web form / email / phone)
        │
        ▼
┌─────────────────────┐
│  Identity           │
│  Verification       │  ← Must prove user is who they claim to be
│  (MFA challenge)    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  DSAR Orchestrator  │
│  ┌───────────────┐  │
│  │ Request Type  │  │
│  │ • Access      │  │
│  │ • Delete      │  │
│  │ • Rectify     │  │
│  │ • Portability │  │
│  └───────────────┘  │
└─────────┬───────────┘
          │
    ┌─────┼──────────────┬──────────────────┐
    ▼     ▼              ▼                  ▼
┌──────┐ ┌────────┐ ┌───────────┐ ┌─────────────────┐
│Access│ │Delete  │ │Rectify    │ │Portability      │
│      │ │        │ │           │ │                 │
│Fan   │ │Fan-out │ │Find field │ │Collect all data │
│out to│ │to all  │ │→ update   │ │→ format as JSON/│
│all   │ │stores  │ │           │ │CSV → deliver    │
│stores│ │        │ │           │ │                 │
│→     │ │→ Hard  │ │           │ │                 │
│compile│ │delete  │ │           │ │                 │
│report│ │        │ │           │ │                 │
└──────┘ └────────┘ └───────────┘ └─────────────────┘
```

---

## 9. Key Architectural Decisions (Trade-off Tables)

### Decision 1: Centralized vs. Federated Privacy Enforcement

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **Centralized** | Single privacy service. All PII access goes through it. | Single enforcement point. Easy to audit. | Single bottleneck. Privacy team becomes gatekeeper. |
| **Federated** | Each service implements privacy controls via shared library/SDK. | No bottleneck. Teams own their compliance. | Inconsistent implementation. Hard to audit globally. |
| **Policy engine + SDK** | Central policy (OPA/Cedar) + thin SDK in each service that calls policy engine. | **Best of both worlds.** Consistent policy, decentralized enforcement. | Policy engine becomes critical dependency. SDK versioning must be managed. |

**Recommended: Policy engine + SDK.** This is the "platform" approach: centralize the rules, federate the enforcement.

### Decision 2: Synchronous vs. Asynchronous Deletion

| Approach | How | Pros | Cons |
|----------|-----|------|------|
| **Synchronous** | Delete blocks until all stores confirm. | User gets immediate confirmation. | Unreliable. One slow store blocks everything. |
| **Asynchronous + DLQ** | Soft delete immediately. Hard delete fans out async with retry and DLQ. | Resilient. Handles transient failures. | User doesn't get immediate confirmation of hard delete. |
| **Event-driven** | Deletion is a Kafka event. All services consume and delete independently. | Loose coupling. Services can evolve independently. | Hard to track completion. Some services may lag forever. |

**Recommended: Asynchronous + DLQ for most data. Synchronous for the "soft delete" (blocking access).** Users care about access being blocked immediately. They don't care about the physical bytes being scrubbed — that's your 30-day window.

### Decision 3: Build vs. Buy for Privacy Infrastructure

| Component | Build | Buy |
|-----------|-------|-----|
| PII Scanner | Custom regex + ML for your data patterns | BigID, OneTrust, Collibra, AWS Macie |
| Consent Management | Custom if simple (< 5 purposes) | OneTrust, Transcend, Didomi |
| DSAR Automation | Custom orchestration + fan-out | Transcend, Ethyca, Mine |
| Policy Engine | OPA (open-source, self-hosted) | AWS Verified Permissions, Auth0 FGA, Permit.io |
| Audit Logging | S3 + Athena + retention policies | Sumo Logic, Datadog, Splunk (for log analysis) |

**The staff-engineer answer:** Start with open-source building blocks (OPA for policy, DataHub for catalog). Buy where the problem is commoditized (OneTrust for consent cookie banners — you don't want to build a cookie banner framework). Build where your architecture is unique (DSAR deletion orchestration across your specific 50 services).

---

## 10. Interview Question: The GDPR Company Launch

### The Scenario

> "Your company is expanding to the EU. You have 3 years of user data across 80 services. The legal team flags that you need GDPR compliance: data subject access requests, right to erasure, consent management, data residency, and audit logging. The CPO wants a plan by Friday. What do you build?"

### Model Answer

**Phase 0 — Triage (Week 1):**
"I'd start by understanding what we're dealing with. What data exists, where does it live, what PII is in it? I'd run an automated PII scanner across all data stores to build a data map. In parallel, I'd identify the highest-risk gaps: do we store any toxic data (credit card CVVs, plaintext passwords)? Are we doing any data transfers from EU to US without Standard Contractual Clauses? The output of this phase is a risk heatmap — not a perfect inventory, but enough to know where the fires are."

**Phase 1 — Stop the Bleeding (Month 1):**
"Implement the three things that carry immediate legal risk:
1. **Consent mechanism** — deploy a consent management platform. Every new user must give explicit consent. Existing users get a consent refresh prompt.
2. **Right to erasure** — build a manual deletion process for the top 5 data stores (the ones holding 80% of user PII). It won't cover everything, but it means we can respond to deletion requests within 30 days for most user data.
3. **Encryption at rest** — ensure all data stores have encryption at rest enabled. This is the quickest compliance win."

**Phase 2 — Platform Build (Months 2–6):**
"Build the privacy platform:
- **Data catalog** — automated PII classification running continuously. Every column in every database is tagged with its PII tier.
- **Consent store** — append-only, immutable consent ledger. Policy engine (OPA) enforcing consent at query time.
- **Deletion orchestrator** — fan-out deletion across all services with retry, DLQ, and verification. Certificate of deletion for audit.
- **Data residency** — implement shard-per-region. EU user data routed to EU infrastructure.
- **Audit logging** — immutable audit log for all PII access."

**Phase 3 — Hardening (Months 6–12):**
"Crypto-shredding for T3/T4 data, automated DSAR pipeline (user self-service), third-party vendor assessment automation, and — critically — delete from backups via tombstone replay or crypto-shredding. By the end of this phase, we can handle 1,000 DSARs/day without human intervention."

**Phase 4 — Privacy-by-Design:**
"Make privacy a platform primitive. New services inherit PII scanning, consent enforcement, deletion fan-out, and audit logging by default. Privacy check passes in CI/CD pipeline — you can't deploy a service that handles PII without a privacy review. The platform team is no longer the bottleneck; the platform IS the enabler."

### Common Pitfall

**❌ "We'll just delete the user from our main database."** This is the #1 mistake junior engineers make. User data replicates through caches, search indexes, data warehouses, Kafka topics with 7-day retention, S3 data lake partitions, ML feature stores, third-party analytics tools, database replicas, and backup snapshots. Deleting from one place without a coordinated fan-out-and-verify strategy is worse than not deleting at all — it creates a false sense of compliance while the data lives on in 30 other places.

**✅ The fix:** Build a deletion orchestrator that maintains a registry of all data stores, fans out deletion to each one with retry logic, verifies deletion with a probe query, and produces a certificate. Any store that fails goes to a human-review DLQ. The system tracks "deletion completeness" as a metric — you're done only when every store confirms.

---

## 11. Operational Considerations

### The 72-Hour Breach Notification Clock

GDPR Article 33: notify the supervisory authority within 72 hours of becoming aware of a personal data breach.

**The engineering implication:** You need automated breach detection and a well-rehearsed incident response playbook. A human triaging alerts on Monday morning will miss the Saturday breach. Your monitoring must cover:

| Signal | What It Detects | Alert Threshold |
|--------|----------------|----------------|
| Unusual data access patterns | Exfiltration in progress | PII access > 3σ above baseline |
| S3 bucket made public | Accidental exposure | Immediate |
| KMS key usage spike | Decryption of mass data | > 10x normal rate |
| New service accessing PII without consent check | Compliance bypass | Any occurrence |
| Audit log tampering | Cover-up attempt | Any modification to immutable log |

### Privacy Metrics Dashboard

What you should measure to prove compliance health:

| Metric | Target | Why |
|--------|--------|-----|
| PII Classification Coverage | 100% of data stores | Unclassified data = unknown risk |
| Deletion Success Rate | 99.9% | Failed deletions = compliance gap |
| Deletion Time (P99) | < 7 days | 30-day SLA with buffer |
| Consent Enforcement Rate | 100% of PII access gated by consent | Any ungated access is a potential violation |
| Audit Log Completeness | 100% of PII access logged | Unlogged access = unprovable compliance |
| DSAR Response Time (P99) | < 14 days | Regulatory requirement with buffer |
| Data Residency Violations | 0 | Any cross-region PII leak is reportable |

---

## 12. Weaknesses & Trade-offs

1. **Crypto-shredding is elegant but operationally terrifying.** Lose the key store, and you've permanently lost all user data — including data you legally need to retain (e.g., financial transactions for tax purposes). Mitigation: never crypto-shred financial data. Use logical deletion for data with legal retention requirements.

2. **The "purpose binding" rabbit hole.** GDPR requires data to be used only for the purpose it was collected for. But "improving our product" and "personalization" are slippery. Overly granular consent UIs drive users away; overly broad consent invites regulatory scrutiny. The sweet spot: 3-5 clearly explained purposes, each with its own toggle.

3. **Backup tombstone sets grow forever.** Over years, the tombstone set of deleted user IDs becomes massive. At some point, restoring a backup takes longer because of tombstone replay than the actual data restore. Mitigation: periodic backup compaction where tombstones are applied and a new clean backup is created.

4. **Third-party data processors are a compliance black hole.** You can delete user data from your systems, but if you sent it to 15 third-party services (analytics, CRM, email provider, push notifications), do they delete it? Mitigation: Data Processing Agreements (DPAs) with contractual deletion obligations + periodic audits. But practically, you're trusting their compliance.

5. **PII in logs is the silent killer.** Error logs, debug logs, access logs — engineers log request bodies, SQL queries, and stack traces that inadvertently contain emails, phone numbers, and tokens. Mitigation: log scrubbing middleware that redacts PII patterns before logs hit storage. Enforce at the logging library level, not at the engineer's discretion.

6. **Anonymization is reversible.** AOL's "anonymized" search data (2006), Netflix Prize dataset (2007), NYC taxi data (2014) — all were re-identified. True anonymization at scale is extremely hard. Assume any dataset with sufficient quasi-identifiers (zip code + age + gender uniquely identifies 87% of the US population) can be re-identified. Use differential privacy when you need mathematical guarantees.

---

## 13. The Compliance Interview Curveball

**"What if a user exercises their right to erasure, but another user has messages FROM that user in their inbox? Do you delete those too?"**

This is the classic GDPR collision: User A's right to erasure vs. User B's right to their own data (and freedom of expression). The legal answer is nuanced and jurisdiction-dependent, but the **engineering answer** is:

1. **Delete User A's account data** (profile, settings, consent history) — clear case.
2. **Anonymize User A's contributions to shared spaces** — replace their name with "[deleted user]" in User B's inbox, group chats, comments, etc. Don't delete the content (that violates User B's rights).
3. **Delete User A's direct messages to User B only if both parties agree** — this is legally grey. Many platforms implement this as: User A deletes from their view; User B still has the message until they also delete.
4. **The architecture implication:** Your data model must distinguish between *owned data* (User A's profile — deletable), *shared data* (messages User A sent to User B — anonymizable), and *derived data* (aggregate statistics that include User A — may require recalculation). This classification must be part of your data catalog.

---

## Related
- [[topic-queue]]
- [[Authentication System (OAuth-JWT-SSO)]]
- [[Event Sourcing & CQRS]] (for immutable consent ledger)
- [[Service Mesh (Istio-Linkerd)]] (for mTLS and audit sidecar)
- [[Data Pipeline Architecture (Kafka + Flink + Lakehouse)]] (for PII in data pipelines)
- [[Privacy & Compliance Systems — Weakness Vault]]

---

## Interview Cheat Sheet

**Key Points to Remember:**
- GDPR right-to-erasure requires deleting ALL user data across ALL systems within 30 days — including backups, logs, analytics, and ML training datasets
- PII classification is the foundation — you can't delete what you haven't identified
- Data residency: EU user data must stay in EU data centers. Architect with region-aware storage from day one
- Audit trail: every access to PII must be logged with who, what, when, and why
- Consent management: track what users agreed to, when, and for what purposes — this drives which data you can use

**Common Follow-Up Questions:**
- "How do you delete user data from ML training datasets?" — You can't surgically remove records from a trained model. Either retrain without the user's data or use differential privacy to make individual contributions unidentifiable.
- "How do you handle deletion across 50 microservices?" — A deletion event published to a message bus, consumed by all services. Track completion with a saga-like coordinator.

**Gotcha:**
- Backups are the hidden GDPR trap. You can delete from production, but if the data exists in a backup from before deletion, you're technically non-compliant. The practical answer is crypto-shredding (encrypt per-user, delete the key) rather than trying to surgically remove records from backup archives.
