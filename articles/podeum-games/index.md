# Podeum Games — Platform Architecture Deep Dive

**Stack:** Java 8, Dropwizard 1.0.6, Guice DI, Hibernate 5.4, MySQL 8, MongoDB, Redis (Redisson), Firebase (Auth + Firestore + FCM + Realtime DB), PhonePe UPI, AWS (S3 + RDS + EKS + OpenTelemetry), Docker, Maven, CircleCI

**Team:** 2 backend engineers

**Scale:** 10K DAU at peak, live sports data processing for multi-format cricket matches

---

## Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────────┐
│                        FLUTTER CLIENT                             │
│              (iOS + Android — Firebase Auth for identity)         │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTPS (JWT Bearer)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    DROPWIZARD APPLICATION                         │
│                      (Single JAR — podeum-backend.jar)            │
│                                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐    │
│  │  Jersey  │ │ Request  │ │  Quartz  │ │ Webhook Endpoints│    │
│  │ REST API │ │ Filters  │ │Scheduler │ │ (SI cricket feed)│    │
│  └────┬─────┘ └──────────┘ └────┬─────┘ └────────┬─────────┘    │
│       │                         │                 │               │
│       ▼                         ▼                 ▼               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   SERVICE LAYER (42 services)                │ │
│  │  Fantasy │ Matches │ Economy │ Quiz │ Pods │ Prediction     │ │
│  │  Leagues │ Players │ Scores  │ Chat │ Badges │ Referrals   │ │
│  └───────────────────────┬─────────────────────────────────────┘ │
│                          │                                        │
│       ┌──────────────────┼──────────────────┐                    │
│       ▼                  ▼                  ▼                     │
│  ┌─────────┐      ┌───────────┐      ┌───────────┐              │
│  │  MySQL  │      │  MongoDB   │      │   Redis   │              │
│  │(Hibernate)│    │ (MongoClient)│    │(Redisson) │              │
│  └────┬────┘      └───────────┘      └─────┬─────┘              │
│       │                                     │                     │
└───────┼─────────────────────────────────────┼─────────────────────┘
        │                                     │
        ▼                                     ▼
┌──────────────┐                    ┌──────────────────┐
│  AWS RDS     │                    │  AWS ElastiCache │
│  (MySQL 8)   │                    │  (Redis)         │
└──────────────┘                    └──────────────────┘

External Providers:
  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐
  │ Firebase │  │   PhonePe    │  │ SportzInteractive│ │    AWS S3    │
  │ Auth +   │  │ UPI Payments │  │ (Live Cricket   │ │ (Live Feed   │
  │ FCM +    │  │              │  │  Data Webhook)  │ │  Archival)   │
  │ Firestore│  └──────────────┘  └───────────────┘  └──────────────┘
  └──────────┘
```

---

## Module Map

| # | Module | Responsibility | Key Technology |
|---|--------|---------------|----------------|
| 1 | **sql-database** | 60+ entities, virtual economy, match stats, users, teams | Hibernate 5.4, MySQL 8, AOP transactions |
| 2 | **database** | Document-type data, live match events, quiz content | MongoDB Java Driver |
| 3 | **api** | 42 services, 40+ REST resources, webhook ingestion | Jersey (JAX-RS), Quartz |
| 4 | **caching** | Redis bucket/map/cache ops, rate limiting, 7-day TTL | Redisson |
| 5 | **payment-gateway** | PhonePe UPI integration, SHA256 signing | PhonePe API v1 |
| 6 | **notifications** | Push (FCM) + in-app (Firestore), topic subscribe | Firebase Admin SDK 6.12 |
| 7 | **runtime** | App bootstrap, Guice wiring, config, filters | Dropwizard, Guice |
| 8 | **deployment** | Docker, Kubernetes, CircleCI, AWS EKS | K8s, Docker |
| 9 | **http-client** | External API call abstraction, JSON deserialization | JAX-RS Client |

---

## Data Flow: Live Cricket Match → Fantasy Score Update

This is the most complex flow in the system — the data pipeline that powers the fantasy gaming engine:

```
SportzInteractive (SI) ──webhook──▶ /podeum/games/match/event
                                        │
                                        ▼
                              MatchEventService.handle()
                                        │
                    ┌───────────────────┼──────────────────┐
                    ▼                   ▼                   ▼
            S3LiveFeedService    FirebaseCricketScore   FantasyScoreService
            (archive raw JSON)   UpdateService          (calculate points)
                    │            (write to Firestore)         │
                    │                   │                    │
                    ▼                   ▼                    ▼
              AWS S3 bucket      Firestore Realtime     MySQL DB update
              "live-feeds"       DB (client app reads)  (player_stats table)
                                                              │
                                                              ▼
                                                     Resilience4j Bulkhead
                                                     (100-thread pool)
                                                              │
                                                              ▼
                                                     FantasyTeam scores
                                                     recalculated per inning
```

---

## Key Architectural Decisions

### 1. Polyglot Persistence: MySQL + MongoDB + Redis
**Decision:** Use MySQL for transactional/relational data (users, economy, teams, matches), MongoDB for document-type data (commentary, events, quiz questions, league configs), Redis for caching and rate-limiting.

**Why:** Virtual economy requires ACID guarantees (double-entry ledger, wallet balances). Match events and commentary are nested, variable-schema documents that don't fit naturally in relational tables. Redis provides sub-millisecond reads for frequently-accessed data like match states and rate-limit counters.

**Tradeoff:** Operational complexity of managing three data stores vs. using a single PostgreSQL with JSONB columns. The team chose polyglot because the access patterns were fundamentally different — MySQL for joins and transactions, MongoDB for append-heavy document writes, Redis for ephemeral counters.

### 2. Hibernate with Declarative Transactions via AOP
**Decision:** Custom `@Transactional` annotation + `MySQLTrxHandler` MethodInterceptor that wraps every annotated method in begin/commit/rollback.

**Why:** Guarantees ACID for economy operations. The `Transaction` entity in MySQL represents real-money UPI transactions processed through PhonePe — double-writes are unacceptable. The AOP approach means no developer can forget to commit.

**Tradeoff:** AOP transactions make testing harder and can mask N+1 query problems. The team accepted this for correctness guarantees.

### 3. Resilience4j Bulkhead for Fantasy Score Calculation
**Decision:** When a live cricket webhook arrives, fantasy scores for ALL active games on that match must be recalculated. Instead of doing this synchronously (which would block the webhook response), the system uses a Resilience4j ThreadPoolBulkhead with 100 threads, 500 queue capacity.

**Why:** A single match can have hundreds of active fantasy games. Recalculating all scores synchronously would cause webhook timeouts and dropped events. The bulkhead isolates this work and provides backpressure via the queue.

**Tradeoff:** Async processing means there's a brief window (~seconds) where the live score shown in-app lags behind the actual match state. Acceptable for fantasy gaming UX.

### 4. Firebase as Multi-Role Provider
**Decision:** Firebase serves four distinct roles: (1) Phone authentication, (2) FCM push notifications, (3) Firestore for in-app notifications and real-time score updates, (4) Realtime Database for live match commentary.

**Why:** Firebase provides a unified SDK that handles all four concerns with a single integration. The Flutter client already uses Firebase for auth; adding FCM and Firestore required zero additional client-side SDKs.

**Tradeoff:** Vendor lock-in to Google Cloud. However, at Podeum's scale (10K DAU), Firebase's free tier covered most usage, making it cost-effective vs. self-hosting alternatives.

### 5. PhonePe UPI with SHA256 + Salt Signing
**Decision:** Payment init requests are base64-encoded, then SHA256-hashed with the merchant API key + salt, sent as `X-VERIFY` header. Status checks use the same signing on the URL path.

**Why:** PhonePe's API spec requires this exact signing mechanism. The implementation wraps it in a clean `Payment` interface with `init()` and `checkStatus()` methods, making it swappable for other payment providers.

### 6. Guice Dependency Injection Over Spring
**Decision:** Use Google Guice with Dropwizard-Guice bridge instead of Spring Boot/Spring DI.

**Why:** Dropwizard-Guce integration was more mature at the time (2018-2019) and the team preferred Guice's explicit module pattern. Each module (`DbModuleSql`, `CachingModule`, `PaymentGatewayModule`, etc.) is a self-contained unit that can be tested in isolation.

**Tradeoff:** Smaller ecosystem than Spring. No `@Transactional`, no `@Cacheable`, no `@Scheduled` — the team built these from scratch (see `MySQLTrxHandler`, `RedisClient`, `JobManager`).

---

## Scale & Performance Notes

- **Single JAR deployment:** All 9 modules compile into `podeum-backend.jar` (~50MB shaded). Deployed as a single container on AWS EKS.
- **MySQL connection pool:** Hibernate default C3P0 pool, configurable per environment.
- **MongoDB connection:** Single `MongoClient` instance, connection string from Dropwizard config.
- **Redis:** Redisson client, single-node (configurable to cluster). 7-day default TTL on cached data.
- **Background jobs:** Quartz scheduler managed via Dropwizard lifecycle (`JobManager`). Jobs include: match state polling, pod status updates, game reward distribution, daily game scheduling.
- **HTTP client:** JAX-RS `Client` with JSON deserialization. Used for external API calls (PhonePe, SI webhooks, self-referencing internal calls for async fan-out).

---

## Navigation

- [Module 1: SQL Database](./01-sql-database) — 60+ entities, economy, transactions
- [Module 2: MongoDB](./02-mongodb) — Document data, live match storage
- [Module 3: API Layer](./03-api-resources) — REST resources, services, webhooks
- [Module 4: Redis Caching](./04-caching) — Bucket/Map/Cache, rate limiting
- [Module 5: PhonePe Payment Gateway](./05-payment-gateway) — UPI integration
- [Module 6: Firebase Notifications](./06-notifications) — Push + in-app messaging
- [Module 7: Runtime & Bootstrap](./07-runtime) — App wiring, config, filters
- [Module 8: Deployment & Infrastructure](./08-deployment) — Docker, K8s, AWS
- [Module 9: HTTP Client](./09-http-client) — External API abstraction
