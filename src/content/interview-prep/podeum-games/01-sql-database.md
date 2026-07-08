---
title: "Module 1: SQL Database — 60+ Entities, Economy & AOP Transactions"
date: 2026-07-08
type: article
tags: [podeum, mysql, hibernate, system-design, economy, transactions, java]
related: [resume-deep-dive]
difficulty: Staff
estimated_reading_time: 30
description: "Deep-dive into the SQL database module powering Podeum Games — 60+ JPA entities, double-entry ledger economy, AOP-driven transaction management, Snowflake ID generation, and the architectural case for MySQL over MongoDB for financial data."
---

# Podeum Games Module 1: SQL Database

## Overview

The `sql-database` module is the persistence backbone of Podeum Games — a fantasy sports gaming platform where users create pods, join prediction games tied to live cricket matches, earn coins, and compete on leaderboards. It manages **55+ repository classes** across **60+ JPA entities**, all backed by **MySQL 8** via **Hibernate 5.4 ORM** with an AOP-driven transaction management layer, a Snowflake-based distributed ID strategy, and a Guice dependency injection framework.

The module lives at `sql-database/src/main/java/com/podeum/database/` and is organized into:

```
com.podeum.database/
├── modules/       → Guice DI module (DbModuleSql.java)
├── configs/       → MySQL connection configuration
├── transactions/  → AOP transaction interceptor
├── entities/      → 60+ JPA entity classes (~20 sub-packages)
│   ├── economy/   → Wallet, Ledger, Transaction, Voucher, etc.
│   ├── users/     → User, UserDevice, UserSubscription
│   ├── pods/      → Pod, PodUser
│   ├── games/     → Game, GameUser, DailyGameQuestion/Answer, etc.
│   ├── matches/   → Match, MatchTeam, MatchPlayer, MatchPlayerStats
│   ├── teams/     → Team, TeamPlayer, FantasyTeam, FantasyPlayer
│   ├── players/   → Player, PlayerSport
│   ├── scores/    → Score, PodScore, ClubMemberScore, Series*Score
│   ├── series/    → Series, SeriesTeam, SeriesTeamPlayer
│   ├── badges/    → Badge, UserBadge
│   ├── referrals/ → Referral
│   ├── notifications/ → NotificationTemplate, NotificationEvent, NotificationCTA
│   ├── leagues/   → League
│   ├── tournaments/ → Tournament
│   ├── sports/    → Sport, SportsFormat
│   ├── venues/    → Venue
│   ├── countries/ → Country
│   ├── sources/   → Source
│   ├── rules/     → Rule
│   ├── roles/     → Skill
│   └── quiz/      → UserAnswers
├── repositories/  → 55+ repository classes (mirrors entities/)
├── utilities/     → IdGenerator (Snowflake)
├── resultsets/    → Custom result-set mappers
└── EMSession.java → Request-scoped EntityManager holder
```

A typical entity count is **~63 entity classes** (excluding the 4 abstract base classes), mapped into ~63 MySQL tables, all using **InnoDB** for row-level locking and ACID guarantees. The migration folder contains **28 sequential SQL migration files** (`0001_production_dump.sql` through `0028_voucher_index_in_ledger.sql`), each adding tables, indexes, or columns as the product evolved.

---

## Entity Inheritance Hierarchy

Every entity in Podeum inherits from a four-level class hierarchy that provides automatic timestamping, optimistic locking, and lifecycle-state management:

```
BaseEntity (@MappedSuperclass)
├── createdAt: Long   (auto-set in @PrePersist)
├── updatedAt: Long   (auto-set in @PrePersist + @PreUpdate)
│
└── VersionEntity (@MappedSuperclass)
    ├── @Version version: Integer  → Hibernate optimistic locking
    │
    └── StateEntity (@MappedSuperclass)
        ├── state: String  → defaults to "created" in @PrePersist
        │
        └── [Concrete entities: User, Wallet, Pod, Game, Match, ...]
```

### BaseEntity — Automatic Timestamps

```java
@MappedSuperclass
public class BaseEntity {
    private Long createdAt;
    private Long updatedAt;

    @PrePersist
    public void create() {
        if (this.createdAt == null)
            this.createdAt = System.currentTimeMillis();
        if (this.updatedAt == null)
            this.updatedAt = System.currentTimeMillis();
    }

    @PreUpdate
    public void update() {
        this.updatedAt = System.currentTimeMillis();
    }
}
```

Timestamps are stored as Unix epoch millis (`bigint(20)` in MySQL), not as `TIMESTAMP` or `DATETIME` types. This avoids timezone conversion issues entirely — the application layer owns time semantics, and all arithmetic uses simple long comparisons.

### VersionEntity — Optimistic Locking

```java
@MappedSuperclass
public abstract class VersionEntity extends BaseEntity {
    @Version
    private Integer version;
}
```

Hibernate's `@Version` annotation provides optimistic concurrency control. On every update, Hibernate issues `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`. If two concurrent transactions try to update the same row, the second one gets a `StaleObjectStateException` (wrapped as `OptimisticLockException`), which the AOP transaction handler catches and rolls back. This is critical for the economy subsystem where racing updates on Wallet balances must be detected and prevented.

### StateEntity — Lifecycle Tracking

```java
@MappedSuperclass
public abstract class StateEntity extends VersionEntity {
    private String state;

    @PrePersist
    public void setState() {
        this.state = "created";
    }
}
```

All domain entities carry a `state` field that tracks their lifecycle. Common states across the system are `"created"`, `"live"`, `"upcoming"`, `"finished"`, `"achieved"`, and `"available"`. Repositories use this field extensively for filtering — e.g., `MatchRepository.findByStatusAndTime()` queries for `state = 'upcoming'` with `startTime > now + 1 hour` to surface matches users can still join.

The `StateRepository` base class provides reusable query methods:

```java
public List<T> findByStatus(String state, int page, int limit) {
    // criteriaBuilder.equal(root.get("state"), state)
}

public List<T> findByState(List<String> states) {
    // root.get("state").in(states)
}
```

---

## Guice Dependency Injection Module (DbModuleSql.java)

The entire database layer is wired together by a single Guice module that binds the Hibernate `EntityManagerFactory`, the `EntityManager`, and the AOP transaction interceptor:

```java
public class DbModuleSql extends AbstractModule {

  @Override
  protected void configure() {
    // Intercept @Transactional methods in API services
    binder()
        .bindInterceptor(
            Matchers.inSubpackage("com.podeum.games.api.services"),
            Matchers.annotatedWith(Transactional.class),
            new MySQLTrxHandler(getProvider(EMSession.class)));
    // Intercept @Transactional methods in notifications
    binder()
        .bindInterceptor(
            Matchers.inSubpackage("com.podeum.notifications"),
            Matchers.annotatedWith(Transactional.class),
            new MySQLTrxHandler(getProvider(EMSession.class)));
  }

  @Provides
  @Singleton
  public EntityManagerFactory entityManagerFactory(MySQLConfig mySQLConfig) {
    return Persistence.createEntityManagerFactory("hibernate-db", mySQLConfig.getProperties());
  }

  @Provides
  public EntityManager entityManager(EntityManagerFactory entityManagerFactory) {
    return entityManagerFactory.createEntityManager();
  }
}
```

Key architectural decisions here:

**Singleton EntityManagerFactory**: Created once at application startup. The `MySQLConfig` object carrying `javax.persistence` properties (JDBC URL, credentials, pool settings) is injected into the `@Provides` method. This means database credentials never touch the `persistence.xml` — they come from environment-specific config.

**Per-request EntityManager**: Each injection of `EntityManager` calls `createEntityManager()`, producing a fresh persistence context. This is NOT the JPA-standard pattern (JPA expects a shared `EntityManager` injected via `@PersistenceContext`), but it works because Guice's default scope is "no scope" (new instance per injection). Combined with the `EMSession` being `@RequestScoped`, each HTTP request gets its own EntityManager.

**AOP interceptor targeting**: Only methods in `com.podeum.games.api.services` and `com.podeum.notifications` that carry `@Transactional` are intercepted. Repository methods themselves are NOT intercepted — transaction boundaries are defined at the service layer, which is the correct architectural choice. The interceptor uses `Matchers.inSubpackage()` (Guice AOP matcher), meaning it will catch service methods in any nested package under those roots.

---

## The EMSession — Request-Scoped EntityManager Holder

```java
@RequestScoped
public class EMSession {
    private EntityManager entityManager;

    public void setEntityManager(EntityManager entityManager) {
        if (this.entityManager == null)
            this.entityManager = entityManager;
    }
}
```

`EMSession` is annotated `@RequestScoped` from `com.google.inject.servlet`, which means Guice's servlet integration creates one instance per HTTP request and shares it across all injections within that request. The `setEntityManager` method has a null-guard — it only sets the EntityManager once, preventing accidental replacement mid-request.

All repositories receive `Provider<EMSession>` via constructor injection, not `EMSession` directly. The `Provider<T>` indirection is essential because:

1. The repository is typically a singleton (default Guice scope for classes without `@Singleton` that are bound explicitly), but the EntityManager is request-scoped.
2. `Provider.get()` defers resolution until the method call, so each repository method call gets the EntityManager belonging to the current HTTP request.

This is the standard Guice "scoping problem" solution — inject a Provider of the narrower-scoped object.

---

## AOP Transaction Architecture

### The Core: MySQLTrxHandler

```java
@Slf4j
@AllArgsConstructor
public class MySQLTrxHandler implements MethodInterceptor {
    private final Provider<EMSession> sessionProvider;

    @Override
    public Object invoke(MethodInvocation methodInvocation) throws Throwable {
        EntityTransaction transaction = sessionProvider.get()
            .getEntityManager().getTransaction();

        // NESTING CHECK: If a transaction is already active, just proceed.
        if (transaction.isActive()) {
            return methodInvocation.proceed();
        }

        Object response = null;
        try {
            transaction.begin();
            response = methodInvocation.proceed();
            transaction.commit();
        } catch (Exception e) {
            transaction.rollback();
            log.error("failed to commit transaction", e);
            throw e;
        }
        return response;
    }
}
```

This is a textbook Guice AOP `MethodInterceptor` (from `org.aopalliance.intercept`, the AOP Alliance standard). Here's the full execution model:

### Transaction Nesting Behavior

The critical line is the nesting check at line 20:

```java
if (transaction.isActive()) {
    return methodInvocation.proceed();
}
```

If `ServiceA.method()` calls `ServiceB.method()`, and both carry `@Transactional`, the inner call detects that a transaction is already active and simply proceeds without starting a new one. This means:

- **No savepoints**: Hibernate does not support nested transactions via savepoints with this approach. The outer transaction owns the commit/rollback decision.
- **No REQUIRES_NEW semantics**: If you need an independent transaction, you'd have to explicitly manage a separate EntityManager, which the framework doesn't support out of the box.
- **All-or-nothing commit**: If the inner method throws, the exception propagates up, triggers rollback in the outermost interceptor, and the entire call stack is rolled back.

This is effectively the **REQUIRED propagation level** from Spring's `@Transactional`, implemented manually.

### The @Transactional Annotation

The code uses `javax.transaction.Transactional` (JTA 1.2), not Spring's `@Transactional`. This is notable because JTA's `@Transactional` was designed for container-managed transactions (EJB, CDI), but here it's used purely as a marker annotation for the Guice AOP matcher. The actual transaction management is handled by `EntityTransaction` (resource-local), not a JTA `UserTransaction`.

In service classes, the annotation is applied at the method level:

```java
// From FantasyTeamService.java
@Transactional
public FantasyTeam createFantasyTeam(FantasyTeamRequest request) {
    // ...
}

@Transactional
public FantasyTeam addPlayerToTeam(String userId, Long teamId, Long matchPlayerId, String role) {
    // ...
}
```

### Flow Diagram

```
HTTP Request
    │
    ▼
Guice Servlet → creates RequestScoped EMSession
    │
    ▼
Service method (@Transactional)
    │
    ▼
MySQLTrxHandler.invoke()
    │
    ├─ transaction.isActive()? ──Yes──→ methodInvocation.proceed()
    │                                      (nested call, no new tx)
    │
    └─ No
        │
        ├─ transaction.begin()
        ├─ methodInvocation.proceed()
        │   ├─ Repository.insertOne()  → em.persist()
        │   ├─ Repository.updateByCriteria() → em.createQuery().executeUpdate()
        │   └─ ...
        │
        ├─ [success] → transaction.commit() → flush to MySQL
        │
        └─ [exception] → transaction.rollback() → discard all changes
                         → re-throw exception
```

### Why Not JTA or Spring?

The choice of a hand-rolled AOP interceptor over Spring's declarative transaction management is pragmatic for a Guice-based application:

1. **No Spring dependency**: Podeum uses Google Guice as its DI framework. Adding Spring just for `@Transactional` would pull in the entire Spring ecosystem.
2. **JTA annotations without JTA**: By using `javax.transaction.Transactional` purely as a marker, the code gets IDE support (annotation validation, refactoring, etc.) without needing a full JTA implementation.
3. **Simplicity**: 38 lines of code handles all transactional behavior. No XML configuration, no `@EnableTransactionManagement`, no `PlatformTransactionManager` beans.

---

## Snowflake ID Generation Strategy

Podeum uses a Twitter-style Snowflake algorithm for generating globally unique, roughly time-sortable IDs. The implementation uses the `xyz.downgoon.snowflake` library:

```java
public class IdGenerator {
    private static final Snowflake snowflake =
        new Snowflake(new Random().nextInt(31), new Random().nextInt(31));

    public static String getId() {
        long uid = snowflake.nextId();
        byte[] b = Base64.getUrlEncoder().withoutPadding().encode(longtoBytes(uid));
        return new String(b);
    }

    private static byte[] longtoBytes(long data) {
        return new byte[]{
            (byte) ((data >> 56) & 0xff),
            (byte) ((data >> 48) & 0xff),
            // ... all 8 bytes
        };
    }
}
```

### How Snowflake Works

The Snowflake ID is a 64-bit long composed of:

```
┌──────────────────────────────────────────────────────────┐
│  timestamp (41 bits) │ datacenter (5) │ worker (5) │ seq │
│  milliseconds since  │ 0-31           │ 0-31       │ 12  │
│  custom epoch        │                │            │     │
└──────────────────────────────────────────────────────────┘
```

- **41 bits for timestamp**: Milliseconds since a custom epoch. Gives ~69 years of IDs.
- **5 bits for datacenter ID**: 0-31, randomized at startup via `new Random().nextInt(31)`.
- **5 bits for worker ID**: 0-31, also randomized at startup.
- **12 bits for sequence**: 0-4095, increments per millisecond, resetting each ms.

### Base64 Encoding

Rather than storing the raw `long` or its decimal representation, Podeum encodes the 8-byte Snowflake value into a **Base64 URL-safe string without padding**:

```
Snowflake long → 8 bytes → Base64 URL-safe → ~11-character string
```

Example: `AAAAAAAAH0o` (decodes to Snowflake ID ~800,000)

This produces shorter, URL-friendly string IDs that are used as primary keys for entities like `User`:

```java
@Entity(name = "users")
public class User extends StateEntity {
    @Id private String id;  // Base64-encoded Snowflake

    @PrePersist
    public void setId() {
        if (this.getId() == null)
            this.id = IdGenerator.getId();
    }
}
```

### Two ID Types

The codebase uses two distinct ID generation strategies:

| Method | Algorithm | Example Output | Used By |
|--------|-----------|----------------|---------|
| `getId()` | Snowflake → Base64 | `"AAAAAAAAH0o"` | User IDs (primary) |
| `getUid()` | UUID.randomUUID() → first 25 chars → uppercase | `"A1B2C3D4-E5F6-7890-ABCDE"` | Transaction external IDs |

`getUid()` is used for `Transaction.externalId` — a client-facing reference that gets shared with payment gateways (PhonePe). The UUID-based approach guarantees global uniqueness without coordination, and the 25-character truncation keeps it compact enough for external API references.

### Critical Issue: Randomized Worker/Datacenter IDs

The Snowflake instance is initialized with `new Random().nextInt(31)` for both datacenter and worker IDs. This means **every JVM restart picks random IDs**, which could theoretically cause collisions if two JVMs happen to pick the same numbers. In production with a single application server this works fine, but in a horizontally-scaled deployment, you'd want to tie datacenter/worker IDs to environment variables or instance metadata (e.g., Kubernetes pod ordinal, EC2 instance ID).

---

## Repository Pattern with Hibernate Session

### Inheritance Hierarchy

The repository layer mirrors the entity hierarchy with a parallel inheritance chain:

```
MySQLRepository<T extends BaseEntity>
│   → Provides: insertOne(), insertMany(), delete(), findById(),
│               findByCriteria(), updateByCriteria(),
│               findByNativeQuery(), updateByNativeQuery()
│
└── VersionRepository<T extends VersionEntity>
    │   (inherits all MySQLRepository methods)
    │
    └── StateRepository<T extends StateEntity>
        │   → Adds: findByStatus(), findByState() (state-filtered queries)
        │
        └── [Concrete repositories: WalletRepository, LedgerRepository, ...]
```

### MySQLRepository — The Foundation

```java
public abstract class MySQLRepository<T extends BaseEntity> {
    private final Provider<EMSession> emSessionProvider;
    private final Class<T> type;  // resolved via reflection

    public MySQLRepository(Provider<EMSession> emSessionProvider) {
        this.emSessionProvider = emSessionProvider;
        this.type = (Class<T>) ((ParameterizedType)
            getClass().getGenericSuperclass()).getActualTypeArguments()[0];
    }

    private EntityManager entityManager() {
        return emSessionProvider.get().getEntityManager();
    }
}
```

The `Class<T>` is resolved at construction time using Java reflection — it reads the generic type argument from the concrete subclass's declaration. So `WalletRepository extends StateRepository<Wallet>` gives `type = Wallet.class`. This enables the Criteria API helpers to create typed queries without the subclass repeating the entity class.

### Core CRUD Operations

```java
public void insertOne(T entity) {
    entityManager().persist(entity);
}

public void insertMany(List<T> entities) {
    entityManager().persist(entities);  // Hibernate batch insert
}

public void delete(T entity) {
    entityManager().remove(entity);
}

public Optional<T> findById(Long id) {
    return Optional.ofNullable(entityManager().find(type, id));
}

public Optional<T> findById(String id) {
    return Optional.ofNullable(entityManager().find(type, id));
}
```

Note the overloaded `findById` — one for `Long` IDs (auto-increment, used by most entities) and one for `String` IDs (Snowflake, used by `User`).

### Criteria API Query Builders

The repository provides protected helper methods that concrete repositories compose to build type-safe queries:

```java
protected CriteriaBuilder getCriteriaBuilder() {
    return entityManager().getCriteriaBuilder();
}

protected CriteriaQuery<T> getCriteriaQuery() {
    return getCriteriaBuilder().createQuery(type);
}

protected Root getRoot(CriteriaQuery<T> criteriaQuery) {
    return criteriaQuery.from(type);
}
```

Concrete repositories use these to build queries with JPA Criteria API:

```java
// From WalletRepository.java
public Optional<Wallet> findByUserId(String userId) {
    CriteriaBuilder cb = getCriteriaBuilder();
    CriteriaQuery<Wallet> cq = getCriteriaQuery();
    Root<Wallet> root = getRoot(cq);

    List<Predicate> predicates = Arrays.asList(
        cb.equal(root.get("user").get("id"), userId)
    );
    return findByCriteria(root, cq, predicates);
}
```

### findByCriteria — The Workhorse

`MySQLRepository` provides multiple overloads of `findByCriteria`:

```java
// Single result (wraps getSingleResult with Optional)
protected Optional<T> findByCriteria(Root<T> root, CriteriaQuery<T> cq,
                                      List<Predicate> predicates) {
    cq.select(root).where(predicates.toArray(new Predicate[]{}));
    try {
        return Optional.ofNullable(
            entityManager().createQuery(cq).getSingleResult());
    } catch (Exception e) {
        return Optional.empty();  // NoResultException → Optional.empty()
    }
}

// Paginated list with ordering
protected List<T> findByCriteria(Root<T> root, CriteriaQuery<T> cq,
                                  List<Predicate> predicates,
                                  List<Order> orderBy,
                                  Integer page, Integer limit) {
    Integer offset = Objects.isNull(page) ? 0 : (page - 1) * limit;
    limit = Objects.isNull(limit) ? Integer.MAX_VALUE : limit;
    cq.select(root).where(predicates.toArray(new Predicate[]{}));
    if (!Objects.isNull(orderBy) && !orderBy.isEmpty())
        cq.orderBy(orderBy);
    try {
        return entityManager().createQuery(cq)
            .setFirstResult(offset).setMaxResults(limit).getResultList();
    } catch (Exception e) {
        return new ArrayList<>();
    }
}
```

The pagination uses standard offset-based paging: `page` is 1-indexed (`(page - 1) * limit`), and `limit` defaults to `Integer.MAX_VALUE` (effectively no limit) when null.

### Native Query Support

For queries that need raw SQL (aggregations, JOINs across un-mapped relationships), the repository provides native query methods:

```java
protected void updateByNativeQuery(String nativeQuery, Map<String, Object> params) {
    Query query = entityManager().createQuery(nativeQuery);
    for (Map.Entry<String, Object> param : params.entrySet()) {
        query.setParameter(param.getKey(), param.getValue());
    }
    query.executeUpdate();
}

protected List findByNativeQuery(String nativeQuery,
                                  Map<String, Object> params,
                                  Class klass) {
    Query query = entityManager().createNativeQuery(nativeQuery);
    // set params...
    return query.getResultList();
}
```

Example usage from `PodRepository`:

```java
public Integer getUserCount(Long podId) {
    String query = "select count(*) from podUsers where podId=:id";
    return Integer.valueOf(
        findByNativeQuery(query, ImmutableMap.of("id", podId), Integer.class)
            .get(0).toString());
}
```

And from `ScoreRepository.findAggregatePodScore()`:

```java
public List<PodScore> findAggregatePodScore(Long podId) {
    String query =
        "select sum(score) score, userId from scores " +
        "where gameId in (select id from games where podId = :podId) " +
        "group by userId";

    List rows = findByNativeQuery(query,
        ImmutableMap.of("podId", podId), null);
    // Manual row-to-object mapping...
}
```

### Update by Criteria

For bulk updates without loading entities:

```java
protected void updateByCriteria(Root<T> root, CriteriaUpdate<T> cu,
                                 List<Predicate> predicates) {
    entityManager().createQuery(
        cu.where(predicates.toArray(new Predicate[]{}))
    ).executeUpdate();
}
```

Used by `ScoreRepository.updateScore()`:

```java
public void updateScore(Score score) {
    CriteriaBuilder cb = getCriteriaBuilder();
    CriteriaUpdate<Score> cu = cb.createCriteriaUpdate(Score.class);
    Root<Score> root = getRoot(cu);

    cu.set(root.get("score"), score.getScore())
      .set(root.get("rank"), score.getRank())
      .set(root.get("timeTaken"), score.getTimeTaken())
      .set(root.get("updatedAt"), System.currentTimeMillis());

    List<Predicate> predicates = Arrays.asList(
        cb.equal(root.get("gameId"), score.getGameId()),
        cb.equal(root.get("userId"), score.getUserId()),
        cb.and(
            cb.or(
                cb.notEqual(root.get("score"), score.getScore()),
                cb.notEqual(root.get("rank"), score.getRank())
            )
        )
    );
    updateByCriteria(root, cu, predicates);
}
```

The OR condition `(score != newScore OR rank != newRank)` is an optimization — it prevents Hibernate from issuing a pointless UPDATE when nothing actually changed, avoiding unnecessary write load and version increments.

---

## Entity-Relationship Map

The Podeum data model can be understood as a layered graph, with `User` at the center:

```
                    Tournament
                        │
                    Series ───── SportsFormat
                        │
    Country ────→ Player ──→ Match ←── Venue
                    │           │
              PlayerSport    MatchTeam ←── Team
                             MatchPlayer
                             MatchPlayerStats

    ┌──────────────────────────────────────────────────┐
    │                                                  │
    ▼                                                  │
  User ──→ Pod ──→ Game ──→ Score                      │
   │        │        │        PodScore                  │
   │      PodUser  GameUser   ClubMemberScore           │
   │                 │         SeriesUserScore          │
   │           DailyGameQuestion  SeriesTeamScore       │
   │           DailyGameAnswer    SeriesClubScore       │
   │           UserAnswer                                │
   │           MysteryPlayer                             │
   │                                                    │
   ├──→ Wallet (1:1)                                    │
   ├──→ Ledger (1:N)                                    │
   ├──→ Transaction (1:N)                                │
   ├──→ Referral (1:N as referrer + referred)           │
   ├──→ UserBadge → Badge                               │
   ├──→ UserDevice                                      │
   ├──→ UserSubscription                                │
   ├──→ FantasyTeam → FantasyPlayer                     │
   └──→ NotificationTemplate / NotificationEvent        │
```

### Key Relationship Paths

**User → Pod → Game → Match → Series**: A user creates or joins a Pod. Each Pod contains one or more Games (prediction contests). Each Game is tied to a Match (a real-world cricket match). Each Match belongs to a Series (e.g., IPL 2024).

**User → FantasyTeam → FantasyPlayer → MatchPlayer → Player**: The fantasy sports subsystem lets users build virtual teams by selecting real players (MatchPlayer records) that are assigned scores based on on-field performance.

**User → Score / PodScore / ClubMemberScore**: Scores are denormalized into multiple tables optimized for different leaderboard queries — per-game scores, aggregate pod scores, and club-level rankings.

**User → Wallet → Ledger**: The virtual economy has its own entity cluster (detailed below).

---

## The Virtual Economy — In Depth

Podeum implements a complete virtual currency system with coins, vouchers, redeemable rewards, and payment gateway integration. It follows double-entry bookkeeping principles — every coin movement is recorded as a ledger entry with a `transactionType` (credit/debit) and a `category`.

### Wallet — The Balance Sheet

```java
@Entity(name = "wallets")
@Cache(usage = CacheConcurrencyStrategy.TRANSACTIONAL)
public class Wallet extends StateEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private Integer coins;                // Current redeemable balance
    private Integer coinsRedeemed;        // Lifetime redeemable spent
    private Integer coinsEarned;          // Lifetime redeemable earned
    private Integer nonRedeemableCoins;   // Current non-redeemable balance
    private Integer nonRedeemableEarned;  // Lifetime non-redeemable earned
    private Integer nonRedeemableRedeemed;// Lifetime non-redeemable spent

    @OneToOne(cascade = CascadeType.PERSIST, fetch = FetchType.LAZY)
    private User user;
}
```

#### Two-Coin System

Podeum splits coins into two categories:

| Coin Type | Earned From | Used For | Can Withdraw? |
|-----------|-------------|----------|---------------|
| **Redeemable** (`coins`) | Game wins, referrals, purchases | Joining paid pods, vouchers, cash redemption | Yes |
| **Non-Redeemable** (`nonRedeemableCoins`) | Welcome bonus, promotions, daily logins | Joining pods, in-app purchases | No |

This is a common pattern in gaming economies — it prevents users from farming sign-up bonuses and immediately cashing out. The guards are explicit:

```java
public Integer getBalance() {
    return this.coins + this.nonRedeemableCoins;
}

public Boolean canDebit(Integer amount) {
    return amount <= coins;  // Only redeemable coins can be withdrawn as cash
}

public Boolean canSpend(Integer amount) {
    return amount <= getBalance();  // Both types can be spent in-app
}
```

#### Derived Balances via @PrePersist/@PreUpdate

Rather than directly mutating `coins` and `nonRedeemableCoins`, the system works with the earned/redeemed accumulators and derives current balances:

```java
@PrePersist
@PreUpdate
public void updateBalance() {
    this.setCoins(this.coinsEarned - this.coinsRedeemed);
    this.setNonRedeemableCoins(
        this.nonRedeemableEarned - this.nonRedeemableRedeemed);
}
```

This means service code increments `coinsEarned` or `coinsRedeemed`, and Hibernate automatically recalculates `coins` before persisting. It's a form of denormalization — the current balance is stored redundantly but kept consistent by the entity lifecycle hooks.

**Architectural tradeoff**: This design couples balance derivation to JPA lifecycle callbacks. If the database is ever updated outside Hibernate (e.g., a batch job via raw SQL), the derived columns will go stale. The migration `0015_locked_coins.sql` suggests they encountered this exact problem and had to add explicit balance columns.

### Ledger — Double-Entry Bookkeeping

```java
@Entity(name = "ledgers")
public class Ledger extends StateEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String transactionType;  // "credit" or "debit"
    private String category;         // "game_win", "referral", "purchase", etc.
    private Long timestamp;
    private Integer amount;
    private Boolean isDeleted;
    private String description;
    private String clientRefId;      // Idempotency key
    private Integer nonRedeemable;   // Portion that is non-redeemable
    private Integer redeemable;      // Portion that is redeemable

    @ManyToOne(cascade = CascadeType.PERSIST, fetch = FetchType.LAZY)
    private User user;

    @OneToOne(cascade = CascadeType.PERSIST, fetch = FetchType.LAZY)
    private Voucher voucher;

    @Type(type = "json")
    private RedirectParams redirectParams;  // { "podId": 123 }
}
```

Every coin movement creates a Ledger entry. The `transactionType` field records whether coins were credited or debited. The `category` field provides granular tracking — `"game_win"`, `"referral_bonus"`, `"pod_join"`, `"voucher_redeem"`, `"coin_purchase"`, etc.

Each Ledger entry also records the split between `redeemable` and `nonRedeemable` portions of the transaction. A game win might credit 100 redeemable + 0 nonRedeemable. A welcome bonus might credit 0 redeemable + 50 nonRedeemable.

#### Idempotency via clientRefId

The `clientRefId` field is a unique constraint in the database:

```sql
UNIQUE KEY `clientRefId` (`clientRefId`)
```

This is critical for payment processing. When PhonePe sends a payment callback, the service attempts to insert a Ledger entry with the transaction's `clientRefId`. If the callback is delivered twice (common with payment gateways), the duplicate insert fails on the unique constraint, and the service treats the second delivery as a no-op. This is an application-level implementation of the **idempotency key** pattern.

```java
// From LedgerRepository.java
public Optional<Ledger> findByClientRefId(String clientRefId) {
    // criteriaBuilder.equal(root.get("clientRefId"), clientRefId)
}
```

#### Composite Indexes for Leaderboard Queries

The migration `0028_voucher_index_in_ledger.sql` and the base migration establish composite indexes:

```sql
KEY `userId_2` (`userId`, `timestamp`),   -- User's transaction history
KEY `userId_3` (`userId`, `transactionType`)  -- Filter by type
```

These indexes support the most common Ledger query pattern — fetching a user's transaction history paginated by time, optionally filtered by type:

```java
public List<Ledger> findTransactions(String userId, String type,
                                      Integer page, Integer size) {
    // ... predicates on userId and optionally transactionType
    // ORDER BY timestamp DESC
    // LIMIT/OFFSET pagination
}
```

### Transaction — Payment Gateway Integration

```java
@Entity(name = "transactions")
public class Transaction extends StateEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String externalId;       // UUID-based, client-facing
    private Integer amount;
    private String paymentMode;      // "phonepe", "upi", etc.
    private String paymentClient;    // PhonePe / GooglePay / etc.
    private String transactionId;    // Gateway's transaction reference
    private String deviceOS;         // "android" or "ios"
    private Long timestamp;

    @ManyToOne(cascade = CascadeType.PERSIST, fetch = FetchType.LAZY)
    private User user;

    @PrePersist
    public void setId() {
        this.externalId = IdGenerator.getUid();
    }
}
```

The `Transaction` entity is distinct from the `Ledger` entity — it represents a **real-money payment** (user buying coins via PhonePe), not a virtual coin movement. The flow is:

```
User initiates purchase → Transaction created (state="created")
    → PhonePe payment flow → callback received
    → Transaction updated (state="completed")
    → Ledger entry created (credit redeemable coins)
    → Wallet.coinsEarned incremented
```

The `TransactionRepository` includes a method for finding stale transactions — payments that are stuck in `"created"` state for more than 5 minutes:

```java
public List<Transaction> find(String state) {
    Long time = System.currentTimeMillis() - (5 * 60 * 1000);
    // root.get("state").in(state)
    // AND timestamp <= 5 minutes ago
}
```

### Voucher System — Prepaid Redemption Codes

```java
@Entity(name = "vouchers")
public class Voucher extends StateEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String clientRefId;
    private String code;          // The voucher code the user enters
    private String pin;           // Optional PIN protection
    private Long expiry;          // Expiration timestamp (epoch millis)
    private Long activeDate;      // Activation timestamp
    private String orderId;       // Batch/order reference
    private String client;        // Partner identifier

    @ManyToOne(cascade = CascadeType.PERSIST, fetch = FetchType.LAZY)
    private Redeemable redeemables;

    @PrePersist
    public void setState() {
        this.setState("available");
    }
}
```

Vouchers are pre-generated codes that users can redeem for coins or merchandise. They're managed in batches via `orderId` and can be restricted to specific `client` partners. The `expiry` field allows time-limited promotional vouchers.

The `UserVoucher` entity tracks which user claimed which voucher:

```java
@Entity(name = "userVouchers")
public class UserVoucher extends StateEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String userId;
    @OneToOne(cascade = CascadeType.PERSIST, fetch = FetchType.LAZY)
    private Voucher voucher;
}
```

#### Voucher Redemption Flow

1. User enters a voucher code in the app
2. `VouchersRepository.findByCodeAndState(code, "available")` looks up the voucher
3. Validations: not expired, not already claimed, PIN matches
4. Voucher state updated to `"redeemed"`
5. `UserVoucher` record created (links user to voucher)
6. `Ledger` entry created: credit with `voucherId` set
7. `Wallet.coinsEarned` incremented by voucher amount

The `voucherId` foreign key on the Ledger table allows auditing — you can trace exactly which voucher funded which coin credit.

### Redeemable — The Rewards Catalog

```java
@Entity(name = "redeemables")
public class Redeemable extends StateEntity {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String image;
    private String brand;
    private Integer coinValue;    // Coins needed to redeem
    private Integer amount;       // Real value (e.g., ₹100)
    private String type;          // "cashback", "voucher", "merchandise"
    private boolean isActive;

    @Type(type = "json")
    private Metadata metadata;    // { termsAndConditions: [...], howToRedeem: [...] }
}
```

`Redeemable` represents items in the rewards store that users can purchase with their coins. The `coinValue` is the price in Podeum coins; `amount` is the real-world value (e.g., ₹100 Amazon voucher). The `metadata` JSON column stores rich content without requiring schema changes:

```json
{
  "termsAndConditions": [
    "Valid only on orders above ₹500",
    "Cannot be combined with other offers"
  ],
  "howToRedeem": [
    "Copy the code from My Rewards",
    "Apply at checkout on Amazon"
  ]
}
```

---

## Persistence Configuration (persistence.xml)

```xml
<persistence-unit name="hibernate-db">
    <provider>org.hibernate.jpa.HibernatePersistenceProvider</provider>

    <!-- 60+ entity class registrations -->
    <class>com.podeum.database.entities.users.User</class>
    <class>com.podeum.database.entities.leagues.League</class>
    <!-- ... -->

    <properties>
        <!-- MySQL 8 JDBC driver -->
        <property name="hibernate.connection.driver_class"
                  value="com.mysql.cj.jdbc.Driver"/>
        <property name="hibernate.dialect"
                  value="org.hibernate.dialect.MySQLDialect"/>

        <!-- Second-level cache via Redis (Redisson) -->
        <property name="hibernate.cache.use_second_level_cache"
                  value="false"/>
        <property name="hibernate.cache.use_query_cache"
                  value="false"/>
        <property name="hibernate.cache.region.factory_class"
                  value="org.redisson.hibernate.RedissonRegionFactory"/>
    </properties>
</persistence-unit>
```

Key observations:

**Explicit entity listing**: All 60+ entity classes are explicitly listed in `<class>` elements. There's no `<exclude-unlisted-classes>` or package scanning — every entity is manually registered. This is intentional for a large codebase: it prevents accidental entity discovery from unlisted classes and makes the persistence unit's scope explicit.

**MySQL 8 with `com.mysql.cj.jdbc.Driver`**: The modern Connector/J driver class. The dialect is the generic `MySQLDialect` rather than `MySQL8Dialect` — Hibernate 5.4's generic MySQL dialect handles version detection automatically.

**Second-level cache**: Configured but **disabled** (`use_second_level_cache = false`). The `RedissonRegionFactory` is declared (Redis-backed Hibernate L2 cache), but the flags are set to false — suggesting this was either never fully rolled out or was disabled due to cache invalidation complexity. Individual entities still carry `@Cache(usage = CacheConcurrencyStrategy.TRANSACTIONAL)` annotations, but those are no-ops when the L2 cache is globally disabled.

**No connection URL in XML**: The JDBC URL, username, and password are NOT in `persistence.xml`. They're injected at runtime via `MySQLConfig.getProperties()` passed to `Persistence.createEntityManagerFactory()`. This separates environment-specific configuration from the application artifact.

---

## Database Migrations

The `sql-database/src/main/resources/migrations/` folder contains **28 sequential SQL migration files**. Unlike Flyway or Liquibase (which use version tables), these appear to be applied manually or via a custom tool. The naming convention is numeric with descriptive suffixes:

```
0001_production_dump.sql         → Initial schema (badges, countries, users, pods, games...)
0002_lfp_changes.sql             → LFP (fantasy) changes
0003_userDevice_changes.sql      → User device tracking
0004_fantasyTeam_changes.sql     → Fantasy team schema evolution
0005_match_coverage_level_changes.sql
0006_user_referral_index.sql     → Referral performance index
0007_updaed_at_index_analytics_indestion.sql
0008_game_join.sql               → Game joining mechanics
0009_economy_v0.sql              → Wallet, Ledger, Redeemable, Voucher tables
0010_podeum_club_badge_v0.sql    → Club badges
0011_rewards_automation.sql      → Automated reward distribution
0012_rules_chanes.sql            → Rules system
0013_social_handles.sql          → User social media links
0014_added_missing_indexes.sql   → Performance optimization pass
0015_locked_coins.sql            → Non-redeemable coin tracking
0016_daily_game.sql              → Daily prediction game
0017_badges_and_medals_leaderboards.sql
0017_user_actions.sql            → User action tracking
0018_user_verification_status.sql → ID verification
0019_notification_tables.sql     → Push/in-app notifications
0020_series_tables.sql           → Series/team normalization
0021_user_tiering.sql            → User tier system
0022_pod_changes.sql             → Pod enhancements
0023_match_table_index.sql       → Match query optimization
0024_payment_transaction_table.sql → Payment transactions
0024_achievedAt_userbadges.sql   → Badge achievement timestamps
0025_Ipl_impact_player_changes.sql
0026_ipl_corner_changes.sql
0027_mystery_player.sql          → Mystery player game
0028_voucher_index_in_ledger.sql → Ledger-voucher join optimization
```

The migrations tell the product evolution story: basic schema → fantasy sports → economy → badges/gamification → notifications → payment integration → advanced game modes.

---

## Why MySQL Over MongoDB

Podeum's domain is fundamentally relational, making MySQL the natural choice over MongoDB. Here's the detailed rationale:

### 1. ACID Guarantees for the Virtual Economy

The wallet/ledger system IS a financial system, just with virtual currency. Every coin transaction must be atomic and durable:

- **Credit 100 coins to User A, debit 100 from User B** (pod join with entry fee): This is a multi-row update across two Wallet rows and two Ledger inserts. In MySQL with InnoDB, this is a single ACID transaction. In MongoDB (pre-4.0), multi-document transactions didn't exist. Even in MongoDB 4.0+, they have significant performance limitations compared to MySQL's mature row-level locking.

- **Idempotency via unique constraint on `clientRefId`**: MySQL's unique index provides a hard guarantee — no two ledger entries with the same `clientRefId` can exist. MongoDB's unique indexes provide similar guarantees, but the combination of unique constraint + transaction rollback is more battle-tested in MySQL.

- **Optimistic locking via `@Version`**: Hibernate's optimistic locking translates to `UPDATE ... WHERE version = ?`. MySQL's MVCC implementation handles this efficiently with row-level locking. MongoDB's document-level concurrency control uses a different model (snapshot isolation with single-document atomicity), which would require a different approach.

### 2. JOINs for Leaderboards

Leaderboards are Podeum's core product feature. They require aggregating data across multiple tables:

```sql
-- Aggregate pod score: sum scores across all games in a pod, grouped by user
SELECT SUM(score) AS score, userId
FROM scores
WHERE gameId IN (SELECT id FROM games WHERE podId = :podId)
GROUP BY userId
```

In MySQL, this is a subquery + aggregation running in a few milliseconds with proper indexes. In MongoDB, this would require either:

- **$lookup** (MongoDB's JOIN): Significantly slower than MySQL JOINs, especially with large collections. Prior to MongoDB 3.6, `$lookup` only supported uncorrelated subqueries.
- **Denormalization**: Store aggregated scores on the Pod document. This creates update anomalies — every score submission must update both the Score document AND the Pod document. Consistency requires multi-document transactions (expensive in MongoDB).

### 3. Schema Enforcement

Fantasy sports has rigid data requirements:

- A Match has exactly 2 MatchTeams (cricket is two-sided)
- A FantasyTeam must have exactly 11 FantasyPlayers (cricket rules)
- A Wallet must have exactly 1 User (one-to-one)

MySQL enforces these via foreign key constraints, unique indexes, and NOT NULL columns. MongoDB's schemaless nature means these constraints must be enforced at the application layer, and schema drift (documents with missing or extra fields) becomes a maintenance burden as the codebase evolves.

### 4. Reporting and Analytics

The 28 migration files show frequent additions of composite indexes for specific query patterns:

```sql
KEY `userId_2` (`userId`, `timestamp`)         -- Transaction history
KEY `userId_3` (`userId`, `transactionType`)    -- Filtered history
KEY `isActive` (`isActive`)                    -- Active redeemables
```

MySQL's B-tree indexes directly support these query patterns. MongoDB's indexing is also strong, but MySQL's query optimizer with decades of development handles complex multi-table JOINs and subqueries more predictably for OLTP workloads like leaderboard generation.

### 5. Ecosystem Familiarity

For an Indian startup building a cricket fantasy platform:

- MySQL is the dominant database in the Indian tech ecosystem
- Hibernate/JPA is the standard ORM for Java services
- Hosting (AWS RDS, DigitalOcean Managed MySQL) is commodity infrastructure
- The talent pool for MySQL administration is far larger than MongoDB

### When MongoDB Would Make Sense

MongoDB would be appropriate for Podeum's:

- **Match scorecards**: The raw ball-by-ball commentary is a deeply nested JSON document that varies dramatically by sport (cricket vs. football vs. kabaddi). This is a classic MongoDB use case — in fact, Podeum likely stores this in a separate service or Redis cache.
- **User session data**: Ephemeral, schema-flexible data with TTL indexes.
- **Analytics events**: High-volume write workloads where eventual consistency is acceptable.

The key insight is that Podeum uses the right tool for the right job: MySQL for the transactional core, and presumably other stores for specialized workloads.

---

## Noteworthy Implementation Details

### DynamicInsert and DynamicUpdate

Every entity carries `@DynamicInsert` and `@DynamicUpdate`:

```java
@DynamicInsert
@DynamicUpdate
@Entity(name = "wallets")
public class Wallet extends StateEntity { ... }
```

These Hibernate annotations change SQL generation: instead of `INSERT INTO wallets (id, userId, coins, coinsRedeemed, coinsEarned, ...) VALUES (?, ?, ?, ?, ?, ...)` with NULLs for unset fields, Hibernate generates `INSERT INTO wallets (id, userId, coins) VALUES (?, ?, ?)` — only the columns with non-null values. This:

- Reduces network payload for wide tables
- Allows MySQL column defaults to take effect (instead of being overridden by explicit NULLs)
- Prevents unnecessary writes to indexed columns

### JSON Columns via Hibernate Types

Several entities use `@Type(type = "json")` with the `vladmihalcea/hibernate-types` library:

```java
@TypeDef(name = "json", typeClass = JsonType.class)
public class Redeemable extends StateEntity {
    @Type(type = "json")
    private Metadata metadata;
}
```

This stores Java objects as MySQL JSON columns, enabling schema flexibility within a relational structure. The library handles serialization/deserialization transparently. Used for:

- `Ledger.redirectParams` — extensible redirect metadata
- `Redeemable.metadata` — terms and conditions
- `Game.attributes` — game-type-specific configuration
- `Match.attributes` — sport-specific match details (e.g., IPL innings data)
- `NotificationTemplate.ctas` — call-to-action buttons
- `User.socialHandles` — social media links

### getSignInValue() — Privacy Guard

```java
public String getSignInValue(){
    return "XXXVIII";
}
```

The `User` entity overrides the getter for `signInValue` (which stores phone numbers/email hashes) to return a redacted string. This prevents accidental logging or serialization of PII. The actual value is retrieved only through explicit repository queries that bypass the getter.

### Ordering Score Algorithm in Pod

The `Pod.updateOrderingScore()` method implements a ranking algorithm based on:

```java
public void updateOrderingScore(Integer creatorTier, Double engScore, Boolean follow) {
    creatorTier = creatorTier == 0 ? 10 : creatorTier;
    this.orderingScore += getGameTimeScore(game);     // Proximity to start time
    this.orderingScore += 1000000L * creatorTier;     // Creator reputation
    this.orderingScore += 1000L * (100.0 - engScore); // Engagement (lower is better)
    this.orderingScore += 10L * (follow ? 1 : 0);     // Social connection
}
```

The `@Transient` annotation on `orderingScore` means it's computed in-memory and never persisted — it's used only for sorting pod discovery results before returning them to the client.

---

## Interview-Ready Summary

If asked "Explain Podeum's database architecture" in an interview, structure your answer around these pillars:

1. **Relational at the core**: MySQL 8 with InnoDB for the virtual economy's ACID requirements. 60+ JPA entities across the fantasy sports domain — users, pods, games, matches, scores, economy.

2. **Entity inheritance**: Four-level class hierarchy (BaseEntity → VersionEntity → StateEntity → concrete) providing timestamps, optimistic locking, and lifecycle state tracking to every entity.

3. **AOP transactions**: Custom `MySQLTrxHandler` implementing `MethodInterceptor` — intercepts `@Transactional` service methods via Guice AOP. Implements REQUIRED propagation semantics. Uses `EntityTransaction` (resource-local), not JTA.

4. **Distributed IDs**: Twitter Snowflake algorithm with Base64 URL-safe encoding for user-facing string IDs. UUID-based IDs for payment gateway references.

5. **Repository pattern**: Generic `MySQLRepository<T>` with JPA Criteria API for type-safe querying, native SQL support for aggregations, and pagination built in. 55+ concrete repositories extending `StateRepository<T>`.

6. **Virtual economy**: Double-entry ledger with idempotency keys (`clientRefId` unique constraint). Two-coin system (redeemable/non-redeemable) with explicit withdrawal guards. Voucher prepayment system linked to redeemable rewards catalog. Payment gateway transaction tracking with stale-transaction detection.

7. **Why MySQL**: ACID for financial integrity, JOIN performance for leaderboard aggregation, schema enforcement for domain constraints, and ecosystem maturity for a Java/Hibernate stack.
