---
title: "Module 2: MongoDB — Document Storage for Live Match Data"
date: 2026-07-09
type: article
tags: [podeum, mongodb, database, document-store, system-design, cricket, fantasy-gaming]
related: [podeum-games, 01-sql-database, 03-api-resources, 04-caching]
audience: [senior-engineer, system-design-interview-prep]
estimated_read_time: 18 min deep read, 8 min skim
---

# Module 2: MongoDB — Document Storage for Live Match Data

The database module (`database/src/main/java/com/podeum/games/database/`) is the document-store half of Podeum's polyglot persistence strategy. While MySQL handles the transactional core — user accounts, virtual economy ledgers, fantasy team rosters — MongoDB absorbs everything that arrives as a nested, variable-schema document: live cricket ball-by-ball events, over-by-over commentary, quiz questions with variable options, league configurations with embedded teams and match schedules.

If Module 1 (MySQL) answers "who owns what and how much money do they have," Module 2 answers "what's happening on the field right now."

---

## 1. Why MongoDB Was Chosen for This Data

The decision to add MongoDB alongside MySQL was driven by the data shape, not by dogma. Three categories of data in the Podeum platform are document-native:

### Live Match Events and Commentary

A single ball in a T20 cricket match generates a payload like this from the SportzInteractive webhook:

```json
{
  "match_id": "SI_2026_IPL_MATCH_47",
  "inning": 1,
  "over": 12.4,
  "batter": "Virat Kohli",
  "bowler": "Jasprit Bumrah",
  "runs": 4,
  "ball_type": "boundary",
  "wicket": null,
  "commentary": "Driven through the covers. Textbook Kohli.",
  "delivery_speed_kph": 142.3,
  "pitch_position": { "x": 0.2, "y": 6.1 },
  "shot_direction": "cover",
  "timestamp_ms": 1749830400000
}
```

This is a nested document with optional fields (`wicket` is null unless a dismissal occurred), sub-objects (`pitch_position`), and variable commentary length. In a relational model, this single event would span 4-5 tables (balls, wickets, commentary, pitch_positions) with nullable foreign keys, and every read would require a multi-table JOIN. In MongoDB, it's one document — one write, one read, no JOINs.

A single T20 match produces 240 balls × 2 innings = 480 ball events plus pre-match and interval commentary. At peak, with multiple simultaneous matches during the IPL, the system ingests ~50 events/second. MongoDB's append-heavy write model (documents are inserted, not updated) handles this without write-contention on shared rows.

### Quiz Content

Quiz questions have a variable structure that resists normalization:

```json
{
  "quiz_id": "quiz_ipw_2026_match_47",
  "question": "Who will score more runs in the powerplay?",
  "options": [
    { "label": "Virat Kohli", "player_id": "p_001" },
    { "label": "Rohit Sharma", "player_id": "p_002" },
    { "label": "Both score equally", "player_id": null }
  ],
  "question_type": "player_comparison",
  "points": 10,
  "correct_answer": null,
  "lock_time_ms": 1749831000000,
  "pod_id": "pod_ipl_2026"
}
```

Questions can have 2-6 options, different `question_type` values (`player_comparison`, `over_prediction`, `match_outcome`), optional player references, and a `correct_answer` that's `null` until the match event confirms the outcome. A relational schema would need EAV (entity-attribute-value) or JSON columns to handle this variability — MongoDB stores it naturally.

### League Configurations

Leagues in Podeum are configured with embedded teams, match schedules, and scoring rules:

```json
{
  "league_id": "league_ipl_2026_fantasy",
  "name": "IPL 2026 Fantasy League",
  "format": "T20",
  "teams": [
    { "team_id": "team_rcb", "name": "Royal Challengers Bangalore", "icon_url": "s3://..." },
    { "team_id": "team_mi", "name": "Mumbai Indians", "icon_url": "s3://..." }
  ],
  "matches": [
    {
      "match_id": "match_ipl_47",
      "team_a": "team_rcb",
      "team_b": "team_mi",
      "scheduled_at_ms": 1749830400000,
      "venue": "Chinnaswamy Stadium"
    }
  ],
  "scoring_rules": {
    "runs_per_boundary": 1.0,
    "wicket_bonus": 25.0,
    "catch_bonus": 10.0,
    "run_out_bonus": 15.0
  }
}
```

This is a deeply nested document where the match schedule and scoring rules are logically part of the league — you never query "find all matches across all leagues for a specific venue" without the league context. Embedding matches inside the league document mirrors how the application consumes the data (fetch league → render all matches).

### Decision Summary

| Concern | MySQL Approach | MongoDB Approach |
|---------|---------------|------------------|
| Match events | 4-5 normalized tables, multi-JOIN reads | Single document per ball event |
| Quiz questions | EAV pattern or JSON column | Native nested documents |
| League configs | Normalized teams/matches/schedules tables | Embedded sub-documents |
| Write pattern | Update-heavy (score recalculation) | Append-heavy (new events, new questions) |
| Schema flexibility | ALTER TABLE migration required | Schema evolves per document |

The key insight: **MongoDB wasn't chosen because "NoSQL is faster." It was chosen because the data is document-shaped.** When your access pattern is "give me everything about ball 12.4" (not "JOIN ball_events to wickets to commentary"), a document database eliminates N+1 problems at the data model level.

---

## 2. The Adapter Pattern with MongoDBAdapter

The MongoDB integration is wrapped behind an adapter interface, following the same pattern as the MySQL module's repository abstraction. This is not just clean architecture — it solved a concrete operational problem at Podeum.

### Architecture

```
┌─────────────────────────────────────────┐
│            SERVICE LAYER                │
│  MatchEventService, QuizService, etc.   │
└───────────────────┬─────────────────────┘
                    │ depends on
                    ▼
┌─────────────────────────────────────────┐
│         MongoDBAdapter (interface)       │
│  + saveMatchEvent(MatchEvent)           │
│  + findEventsByMatch(matchId, limit)    │
│  + saveQuizQuestion(QuizQuestion)       │
│  + findQuizByPod(podId)                 │
│  + findLeagueById(leagueId)             │
│  + saveCommentary(MatchCommentary)      │
│  + ...                                  │
└───────────────────┬─────────────────────┘
                    │ implemented by
                    ▼
┌─────────────────────────────────────────┐
│  MongoDBAdapterImpl                     │
│  - mongoClient: MongoClient             │
│  - database: MongoDatabase              │
│  - repositories: Map<String, Repository>│
│  + delegates to typed repositories      │
└───────────────────┬─────────────────────┘
                    │ delegates to
                    ▼
┌─────────────────────────────────────────┐
│         MongoDB Repositories            │
│  MatchEventRepository                   │
│  MatchCommentaryRepository              │
│  QuizRepository / QuestionRepository    │
│  LeagueRepository / LeagueTeamRepo...   │
│  PodUserRepository, ReferralLinkRepo... │
└─────────────────────────────────────────┘
```

### Why the Adapter Pattern?

Three reasons, each grounded in a real operational concern:

**1. Swappable backend.** When Podeum started, the team ran MongoDB locally on a single EC2 instance during development. In production, it moved to MongoDB Atlas (managed) and later to a self-hosted replica set on the EKS cluster. The adapter interface meant zero service-layer code changes across these migrations. The `MongoDBAdapterImpl` was the only file that changed — swapping `MongoClient` connection strings and replica-set configs.

**2. Testability.** Every service that needs MongoDB receives the `MongoDBAdapter` interface via Guice constructor injection. Unit tests mock the adapter. Integration tests use a real adapter pointed at an embedded MongoDB instance (Flapdoodle or Testcontainers, depending on the CI environment). Without the interface, mocking `MongoCollection<Document>` directly is brittle — the adapter provides a semantic API (`saveMatchEvent`, not `collection.insertOne`).

**3. Failure isolation.** MongoDB connection failures (timeouts, replica-set elections) surface inside `MongoDBAdapterImpl` and can be wrapped in domain exceptions (`DatabaseException`, `ConnectionTimeoutException`) rather than leaking `MongoTimeoutException` into service code. This keeps the service layer database-agnostic.

### Repository Pattern

Each MongoDB collection has a dedicated repository class under `adapters/mongodb/repositories/`. The full set:

| Repository | Collection | Purpose |
|-----------|-----------|---------|
| `MatchEventRepository` | `match_events` | Ball-by-ball events from SI webhook |
| `MatchCommentaryRepository` | `match_commentary` | Over-by-over text commentary |
| `QuizRepository` | `quizzes` | Quiz containers (one per pod per match) |
| `QuestionRepository` | `questions` | Individual quiz questions |
| `QuizResultRepository` | `quiz_results` | User answers and scores |
| `QuizPodRepository` | `quiz_pods` | Groups of quizzes (e.g., "IPL 2026 Pod") |
| `LeagueRepository` | `leagues` | League configs with embedded teams |
| `LeagueTeamRepository` | `league_teams` | Team metadata within leagues |
| `LeagueMatchRepository` | `league_matches` | Match schedules in leagues |
| `LeagueMatchPlayerRepository` | `league_match_players` | Player participation records |
| `PlayerAnalyticsRepository` | `player_analytics` | Aggregated player stats |
| `PodUserRepository` | `pod_users` | User membership in pods |
| `PlayerSelectedPercentage` | `player_selected_pct` | Fantasy selection percentages |
| `UserFollowRepository` | `user_follows` | Social follow relationships |
| `ReferralLinkRepository` | `referral_links` | Referral tracking |

Each repository encapsulates collection-specific query logic. For example, `MatchEventRepository` knows how to query events by `match_id` and `inning`, sorted by `over` ascending. `QuizRepository` knows how to find active quizzes (where `lock_time_ms > now()` and `correct_answer IS NULL`).

---

## 3. Document Schemas for Match Events, Quiz, Leagues

MongoDB is schemaless at the database level, but Podeum enforces document structure at the application layer through typed POJOs with the custom `@Collection` annotation.

### The `@Collection` Annotation

```java
@Collection(name = "match_events")
public class MatchEvent {
    @Id
    private String id;           // Generated by UidGenerator
    private String matchId;      // SI match identifier
    private int inning;
    private double over;
    private String batter;
    private String bowler;
    private int runs;
    private String ballType;     // "dot", "single", "boundary", "wicket"
    private WicketDetail wicket; // null if no wicket
    private String commentary;
    private double deliverySpeedKph;
    private PitchPosition pitchPosition;
    private String shotDirection;
    private long timestampMs;
}

public class WicketDetail {
    private String dismissedPlayer;
    private String dismissalType;  // "bowled", "caught", "lbw", "run_out", "stumped"
    private String fielder;        // null for bowled/lbw
}
```

The `@Collection` annotation maps the class to a MongoDB collection name, similar to JPA's `@Table`. The `@Id` field maps to MongoDB's `_id`. Types are strongly enforced at the Java level — MongoDB stores them as BSON and the driver handles deserialization.

The `UidGenerator` utility (under `utils/`) generates unique, sortable IDs for all MongoDB documents. This is important because MongoDB's default `ObjectId` is 12 bytes and includes a timestamp component, but Podeum uses its own ID scheme for cross-store consistency (matching IDs in MySQL and MongoDB for debugging replay).

### Match Commentary Schema

Commentary is stored separately from match events because it has a different access pattern. Events are queried by ball sequence; commentary is queried by time range for the live feed UI:

```java
@Collection(name = "match_commentary")
public class MatchCommentary {
    @Id
    private String id;
    private String matchId;
    private String text;           // "Kohli drives through the covers for four!"
    private long timestampMs;
    private String type;           // "ball", "over_break", "wicket", "milestone"
    private String language;       // "en", "hi", "kn" — Podeum supports multi-language
    private Map<String, Object> metadata; // extra fields from SI feed
}
```

The `metadata` field uses MongoDB's native flexibility — the SI webhook sometimes sends extra fields (player milestone data, sponsorship triggers) that don't have a fixed schema. Storing them as a `Map<String, Object>` means the application doesn't need to model every possible SI field.

### Quiz Result Schema

Quiz results capture the full lifecycle of a user interaction:

```java
@Collection(name = "quiz_results")
public class QuizResult {
    @Id
    private String id;
    private String quizId;
    private String questionId;
    private String userId;
    private String selectedOption;  // option label chosen by user
    private boolean correct;        // null until answer is verified
    private int pointsAwarded;
    private long answeredAtMs;
    private long verifiedAtMs;      // when the correct answer was confirmed via match event
}
```

The `correct` and `pointsAwarded` fields are populated asynchronously — the user answers a question (write), then later when the match event confirms the outcome, the `QuizResultService` updates the result (update). This is one of the few update-heavy patterns in MongoDB for Podeum (most writes are insert-only).

### Index Strategy

MongoDB requires explicit index creation for query performance. The key indexes on Podeum's collections:

| Collection | Index | Type | Purpose |
|-----------|-------|------|---------|
| `match_events` | `{matchId: 1, inning: 1, over: 1}` | Compound | Fetch events for a match, sorted by ball sequence |
| `match_events` | `{timestampMs: 1}` | TTL | Auto-delete events older than 90 days |
| `match_commentary` | `{matchId: 1, timestampMs: -1}` | Compound | Latest commentary for live feed |
| `questions` | `{quizId: 1}` | Simple | All questions for a quiz |
| `quiz_results` | `{userId: 1, quizId: 1}` | Compound | User's results for a specific quiz |
| `quiz_results` | `{quizId: 1, verifiedAtMs: 1}` | Compound | Find unverified results to process |
| `leagues` | `{leagueId: 1}` | Unique | Lookup by league ID |
| `player_selected_pct` | `{matchId: 1, playerId: 1}` | Compound Unique | Percentage lookup per player per match |
| `referral_links` | `{referralCode: 1}` | Unique | Lookup by referral code |

The TTL index on `match_events.timestampMs` is noteworthy — match events older than 90 days are automatically deleted by MongoDB's background TTL reaper. This keeps the collection size bounded without application-level cron jobs. Historical data is archived to S3 before expiry via the `S3LiveFeedService`.

---

## 4. How MongoDB Complements MySQL

This is the question interviewers care about: "Why two databases? Why not just use PostgreSQL JSONB for everything?" The answer isn't "NoSQL" — it's about access patterns and operational profiles.

### The Division of Responsibility

```
                    ┌──────────────────────────────┐
                    │      APPLICATION LAYER        │
                    └──────────┬───────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
    ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
    │    MySQL     │   │   MongoDB    │   │    Redis     │
    │ (Hibernate)  │   │(MongoClient) │   │  (Redisson)  │
    └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
           │                  │                   │
    ┌──────▼───────┐   ┌──────▼───────┐   ┌──────▼───────┐
    │ Transactional │   │  Document    │   │  Ephemeral   │
    │ + Relational  │   │  + Variable  │   │  + Cached    │
    │ Users, Money, │   │  Schema Data │   │  Counters,   │
    │ Teams, Matches│   │ Events, Quiz │   │  Sessions    │
    └──────────────┘   └──────────────┘   └──────────────┘
```

MySQL owns the **transactional core**: anything that requires ACID guarantees, multi-table JOINs, or referential integrity across 60+ entities. User wallets, virtual currency transactions (with double-entry ledger), fantasy team selections, match metadata, and player profile tables — these are all relational because the queries JOIN across them constantly ("find all transactions for user X in match Y where the amount exceeds Z").

MongoDB owns the **append-heavy, variable-schema data**: match events, commentary, quizzes, and league configurations. These are written far more than they're updated, have schemas that vary per document (a ball with a wicket has different fields than a dot ball), and are almost always read in their entirety (fetch all events for match X, fetch all questions for quiz Y).

Redis owns **ephemeral, sub-millisecond data**: rate-limit counters, user session caches, live match state snapshots, fantasy leaderboard caches. Anything that needs to survive less than 7 days and be readable in under 1ms.

### Why Not PostgreSQL JSONB?

This is the "simpler alternative" question. Here's the honest answer:

| Criterion | PostgreSQL JSONB | MongoDB |
|-----------|-----------------|---------|
| Document writes (append-heavy) | Performs well | Performs well |
| Document reads (fetch by ID) | Performs well | Performs well |
| Querying nested fields | `jsonb_path_query` — powerful but verbose | Native dot-notation — concise |
| TTL-based auto-expiry | Requires pg_cron + DELETE job | Built-in TTL indexes |
| Horizontal scaling (sharding) | Complex (Citus or manual partitioning) | Native sharding on any field |
| Operational overhead | One database to manage | Two databases to manage |
| Write throughput (append-only) | Limited by WAL and vacuum | Optimized for append-heavy workloads |
| Schema evolution | `ALTER TABLE...ALTER COLUMN` | Add fields to POJO, no migration needed |

The deciding factor for Podeum was operational, not technical: **the MongoDB instance can be tuned independently from MySQL.** During an IPL match, match events spike to 50 writes/second, and the MongoDB instance gets more CPU and IOPS. During off-hours when users check their wallets and transaction history, MySQL gets the resources. With a single PostgreSQL instance, these workloads compete for the same connection pool, buffer cache, and WAL bandwidth.

The second factor: **TTL indexes for match event auto-expiry.** In PostgreSQL, you'd need a cron job (Quartz in Podeum's case) that runs `DELETE FROM match_events WHERE timestamp < now() - interval '90 days'` in batches. This creates vacuum pressure, table bloat, and a background job to monitor. MongoDB's TTL index is fire-and-forget — the database handles it.

### Cross-Store Consistency

Podeum does NOT maintain transactional consistency across MySQL and MongoDB. There is no two-phase commit. The `@Transactional` annotation on the MySQL side uses AOP to wrap Hibernate sessions, but MongoDB operations are fire-and-forget within the same service method. If a service writes to MySQL and then MongoDB in the same method, and MongoDB fails, the MySQL write is NOT rolled back.

This was a deliberate tradeoff. The data in MongoDB (match events, quiz results, commentary) is **derived from external sources** (the SI webhook), not generated by Podeum's own business logic. If a match event fails to write to MongoDB, the SI webhook will retry (it's idempotent by match event ID). If a quiz result fails to write, the user can re-answer. The cost of distributed transactions (performance, complexity, operational overhead) was not justified for data that can be replayed or recomputed.

The one exception: `ReferralLinkRepository` writes to MongoDB AND `Transaction` entity writes to MySQL happen in the same referral flow. Here, the service uses a **compensating transaction pattern** — if MongoDB write succeeds but MySQL write fails, a background job cleans up orphaned referral links. This is acceptable because referral link creation is low-frequency (not per-ball-event).

---

## 5. Connection Management

### MongoDBConfig.java

Connection setup is centralized in `MongoDBConfig.java`, which reads from the Dropwizard configuration YAML:

```java
public class MongoDBConfig {
    private String connectionString;  // mongodb://user:pass@host:27017/db?replicaSet=rs0
    private String databaseName;      // "podeum_games"
    private int minPoolSize;          // 10
    private int maxPoolSize;          // 100
    private int maxIdleTimeMs;        // 60000
    private int serverSelectionTimeoutMs; // 5000
    private int connectTimeoutMs;     // 3000
    private int socketTimeoutMs;      // 10000
}
```

The `MongoDBAdapterImpl` receives this config via Guice and creates a single `MongoClient` instance:

```java
@Singleton
public class MongoDBAdapterImpl implements MongoDBAdapter {
    private final MongoClient mongoClient;
    private final MongoDatabase database;
    private final Map<Class<?>, Object> repositories;

    @Inject
    public MongoDBAdapterImpl(MongoDBConfig config) {
        MongoClientSettings settings = MongoClientSettings.builder()
            .applyConnectionString(new ConnectionString(config.getConnectionString()))
            .applyToConnectionPoolSettings(builder -> builder
                .minSize(config.getMinPoolSize())
                .maxSize(config.getMaxPoolSize())
                .maxConnectionIdleTime(config.getMaxIdleTimeMs(), MILLISECONDS))
            .applyToClusterSettings(builder -> builder
                .serverSelectionTimeout(config.getServerSelectionTimeoutMs(), MILLISECONDS))
            .applyToSocketSettings(builder -> builder
                .connectTimeout(config.getConnectTimeoutMs(), MILLISECONDS)
                .readTimeout(config.getSocketTimeoutMs(), MILLISECONDS))
            .build();
        this.mongoClient = MongoClients.create(settings);
        this.database = mongoClient.getDatabase(config.getDatabaseName());
        this.repositories = initializeRepositories();
    }
}
```

### Connection Pool Sizing

The pool is sized conservatively:

- **Min: 10 connections** — Keeps a warm pool even during low-traffic periods. Prevents cold-start latency on the first request after idle.
- **Max: 100 connections** — Sized for peak IPL traffic (~50 writes/sec + ~200 reads/sec for live score queries). MongoDB's default max is also 100, so this saturates the driver-side pool without overwhelming the server.

Connection pooling is critical because every webhook event triggers a write to `match_events`, and every user viewing a live match triggers reads from both `match_events` (scoreboard) and `match_commentary` (live feed). During an IPL playoff match with 8,000 concurrent users, the read load on MongoDB is significant.

### Timeout Configuration

| Timeout | Value | Rationale |
|---------|-------|-----------|
| Server selection | 5 seconds | MongoDB replica-set elections can take 2-3 seconds. 5s gives headroom without causing client-side request pileup. |
| Connection | 3 seconds | Fast failure. If MongoDB isn't reachable within 3s, something is wrong (network partition, instance down). |
| Socket read | 10 seconds | Some queries scan large result sets (e.g., all events for a match: 480+ documents). 10s allows these to complete without premature timeout. |
| Max idle time | 60 seconds | Connections idle longer than 60s are closed and recreated. Prevents stale connections from surviving past network blips. |

### Error Handling with TransactionException

The `exceptions/TransactionException.java` wraps all MongoDB driver exceptions into a domain exception hierarchy:

```java
public class TransactionException extends RuntimeException {
    private final String operation;  // "SAVE_MATCH_EVENT"
    private final String collection; // "match_events"
    private final String entityId;   // the document _id

    public TransactionException(String operation, String collection,
                                 String entityId, Throwable cause) {
        super(String.format("MongoDB %s failed on %s for entity %s: %s",
              operation, collection, entityId, cause.getMessage()), cause);
        this.operation = operation;
        this.collection = collection;
        this.entityId = entityId;
    }
}
```

This exception carries enough context to debug without needing to grep through logs — operation name, collection, and entity ID are all in the exception message. Service-layer code catches `TransactionException` and maps it to appropriate HTTP error responses (503 for connection failures, 500 for write failures, 409 for duplicate key violations that indicate a webhook retry).

### Graceful Shutdown

The `MongoDBAdapter` implements Dropwizard's `Managed` interface to register with the application lifecycle:

```java
@Override
public void stop() {
    if (mongoClient != null) {
        mongoClient.close(); // returns connections to pool, then closes pool
    }
}
```

On application shutdown (SIGTERM from Kubernetes during a rolling deploy), `stop()` is called before the process exits. This ensures in-flight writes complete and connections are returned to the pool cleanly, preventing "connection reset" errors on the MongoDB server side.

---

## Summary: When to Use the MongoDB Pattern

The MongoDB module demonstrates a pattern applicable to any system that ingests third-party data feeds:

1. **Document-shaped data belongs in a document store.** Don't normalize variable-schema event payloads into 5 relational tables when your access pattern is "fetch all events for this match."

2. **Adapter interfaces make polyglot persistence maintainable.** The `MongoDBAdapter` abstraction means services never know which database they're talking to, making migrations and testing possible.

3. **TTL indexes eliminate background-job complexity.** Auto-expiring match events after 90 days is cleaner than writing and monitoring a cron job.

4. **Accept eventual consistency across stores.** Two-phase commit across MySQL and MongoDB isn't worth it when the data is externally sourced and replayable. Compensating transactions for the rare cases where both stores must agree.

5. **Separate operational profiles.** MongoDB and MySQL can be scaled independently — MongoDB gets IOPS during matches, MySQL gets IOPS during portfolio viewing. A single PostgreSQL JSONB instance forces these workloads to compete.

---

**Next:** [Module 3: API Layer](./03-api-resources) — REST resources, services, and webhook ingestion  
**Previous:** [Module 1: SQL Database](./01-sql-database) — 60+ entities, economy, transactions
