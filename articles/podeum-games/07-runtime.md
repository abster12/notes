---
title: "Module 7: Runtime & Bootstrap — Dropwizard Application Lifecycle, Guice Wiring, and Filter Pipeline"
date: 2026-07-09
type: article
tags: [podeum, dropwizard, guice, runtime, bootstrap, dependency-injection, system-design, fantasy-gaming]
related: [podeum-games, 01-sql-database, 02-mongodb, 03-api-resources, 04-caching]
audience: [senior-engineer, system-design-interview-prep]
estimated_read_time: 25 min deep read, 12 min skim
---

# Module 7: Runtime & Bootstrap — Dropwizard Application Lifecycle, Guice Wiring, and Filter Pipeline

The runtime module (`runtime/src/main/java/com/podeum/games/runtime/`) is the entry point that transforms a collection of independent Java modules into a running production application. It answers the question: "How do 9 Guice modules, 2 databases, a Redis cluster, a Quartz scheduler, Firebase, PhonePe, and 40+ JAX-RS resources all start up together in a single JVM and stay running?"

The answer spans 84 lines in `GameApplication.java` and a supporting cast of filters, health checks, configuration files, and Guice modules that together form the bootstrap skeleton of Podeum Games.

---

## 1. GameApplication.java: The Single Entry Point

`GameApplication.java` extends Dropwizard's `Application<GameConfig>` class. This is the class referenced in the Maven Shade plugin's `Main-Class` manifest entry — when the JAR launches, Dropwizard's `ServerCommand` calls `initialize()` then `run()`.

```java
public class GameApplication extends Application<GameConfig> {

    public static void main(String[] args) throws Exception {
        new GameApplication().run(args);
    }

    @Override
    public void initialize(Bootstrap<GameConfig> bootstrap) {
        // 9 Guice modules wired here
    }

    @Override
    public void run(GameConfig config, Environment environment) {
        // Filters, health checks, Quartz, timezone, RSA tokens
    }
}
```

The Dropwizard lifecycle has two distinct phases, and the separation between them is deliberate:

### Phase 1: `initialize(Bootstrap)` — Declarative Wiring

This phase runs BEFORE the configuration file is fully parsed and BEFORE any managed resources (database connections, Redis clients, HTTP server) are started. It's for declaring bindings — telling Guice "when someone asks for Interface X, give them Implementation Y." No I/O should happen here.

Podeum's `initialize()` wires **9 Guice modules** via the Dropwizard-Guice bridge:

```java
@Override
public void initialize(Bootstrap<GameConfig> bootstrap) {
    GuiceBundle<GameConfig> guiceBundle = GuiceBundle.<GameConfig>newBuilder()
        .addModule(new ConfigModule())
        .addModule(new ClientModule())
        .addModule(new DBModule())            // MongoDB
        .addModule(new WebhookModule())
        .addModule(new TransactionModule())
        .addModule(new FireBaseModule())
        .addModule(new DbModuleSql())         // MySQL (Hibernate)
        .addModule(new CachingModule())       // Redis (Redisson)
        .addModule(new PaymentGatewayModule()) // PhonePe
        .enableAutoConfig("com.podeum.games.resources")  // Scan for JAX-RS @Path
        .setConfigClass(GameConfig.class)
        .build(Stage.DEVELOPMENT);   // Eager singleton creation
    bootstrap.addBundle(guiceBundle);
}
```

### Phase 2: `run(GameConfig, Environment)` — Operational Startup

This phase runs AFTER configuration is deserialized from the YAML file and AFTER the Jetty HTTP server is ready. It's for registering runtime components: filters, health checks, servlets, managed objects (lifecycle start/stop).

```java
@Override
public void run(GameConfig config, Environment environment) {
    // 1. Set JVM timezone
    TimeZone.setDefault(TimeZone.getTimeZone("Asia/Kolkata"));

    // 2. Generate RSA token for internal service-to-service auth
    setEnvVars(environment);

    // 3. Register health checks
    environment.healthChecks().register("mongodb", new HealthTask(config));

    // 4. Start Quartz scheduler
    JobManager jobManager = GuiceBundle.getInjector().getInstance(JobManager.class);
    jobManager.start();

    // 5. Register request filters (order matters!)
    environment.jersey().register(new RequestSessionFilter());
    environment.jersey().register(new RequestFilter());

    // 6. Enable multipart file uploads
    environment.jersey().register(MultiPartFeature.class);
}
```

---

## 2. The 9 Guice Modules: Why Each One Exists

A common alternative to 9 Guice modules is one giant "AppModule" that binds everything. Podeum rejected that approach for three reasons:

1. **Testability**: Each module can be tested in isolation. A unit test for `CachingModule` doesn't need MySQL or Firebase bindings — it mocks or provides stubs for the Redis configuration and tests that `RedisClient` is correctly wired.

2. **Startup failure isolation**: If `DbModuleSql` fails to connect to MySQL, the application crashes with a clear error: `DbModuleSql: unable to connect to jdbc:mysql://...`. With a monolithic module, the error is "Guice creation errors" with a 200-line stack trace.

3. **Mental model for the team**: Two engineers, 9 modules. Each module maps to exactly one external dependency or cross-cutting concern. When debugging a caching issue, you know to look in `CachingModule`. When debugging a payment issue, `PaymentGatewayModule`.

### Module-by-Module Breakdown

| # | Module | Responsibility | Key Bindings | Failure Mode |
|---|--------|---------------|--------------|--------------|
| 1 | `ConfigModule` | Deserialize YAML config into typed POJOs | `GameConfig` → parsed config; sub-configs (`RedisConfiguration`, `MySQLConfiguration`, `MongoConfiguration`) from config fields | Missing/wrong YAML field → Jackson deserialization error at startup |
| 2 | `ClientModule` | HTTP client for external API calls | `HttpClient` (interface) → `HttpImplementation` (JAX-RS Client wrapper) | Connection pool exhausted at runtime (runtime failure, not startup) |
| 3 | `DBModule` | MongoDB connection | `MongoClient` → singleton from connection string in config | MongoDB unreachable → `MongoTimeoutException` at startup |
| 4 | `WebhookModule` | Webhook routing | `WebhookEvent` → `SportzInteractiveHandler` | Request routing to wrong handler (logical error, caught in integration tests) |
| 5 | `TransactionModule` | Database transaction AOP | `@Transactional` interceptor → `MySQLTrxHandler` MethodInterceptor | N+1 query or unclosed session if interceptor misconfigured |
| 6 | `FireBaseModule` | Firebase SDK initialization | `FirebaseAuth`, `FirebaseMessaging`, `Firestore` → singleton wrappers | Firebase credentials file missing/expired → startup failure |
| 7 | `DbModuleSql` | MySQL + Hibernate | `SessionFactory` → Hibernate session factory; `@Transactional` DAO bindings | MySQL unreachable → connection pool timeout at startup |
| 8 | `CachingModule` | Redis via Redisson | `RedissonClient` → singleton from `RedisConfiguration`; `RedisClient` → singleton | Redis unreachable → Redisson retries (3 attempts, 1.5s interval), then startup failure |
| 9 | `PaymentGatewayModule` | PhonePe UPI | `Payment` (interface) → `PhonePeClient`; API key + salt from config | Invalid API key → PhonePe 401 at first transaction (runtime, not startup) |

### Dependencies Between Modules

```
ConfigModule ───────── (all modules depend on this for config)
    │
    ├──▶ ClientModule ─────────▶ HttpClient (JAX-RS Client)
    │
    ├──▶ DBModule ────────────▶ MongoClient
    │
    ├──▶ DbModuleSql ─────────▶ SessionFactory (Hibernate)
    │       │
    │       └──▶ TransactionModule ──▶ @Transactional interceptor (depends on SessionFactory)
    │
    ├──▶ CachingModule ───────▶ RedissonClient → RedisClient
    │
    ├──▶ FireBaseModule ──────▶ FirebaseAuth, FirebaseMessaging, Firestore
    │
    ├──▶ PaymentGatewayModule ─▶ PhonePeClient (depends on ClientModule's HttpClient)
    │
    └──▶ WebhookModule ───────▶ SportzInteractiveHandler (depends on DBModule, CachingModule, FireBaseModule)
```

The dependency chain is a DAG (Directed Acyclic Graph) — no circular dependencies. This is enforced by the constructor injection pattern: if Module A needs something from Module B, Module A's constructor takes a parameter of the type Module B provides, and Guice resolves it at injection time.

### Stage.DEVELOPMENT: Eager Singleton Creation

```java
.build(Stage.DEVELOPMENT);
```

Guice has three stages: `TOOL`, `DEVELOPMENT`, and `PRODUCTION`. The difference:

| Stage | Singleton Creation | Error Detection | Use Case |
|-------|-------------------|----------------|----------|
| `TOOL` | Lazy (on first injection) | Errors at injection time | IDE plugins, development tools |
| `DEVELOPMENT` | **Eager** (all singletons created at injector creation) | Immediate — all wiring errors surface at startup | Podeum's choice |
| `PRODUCTION` | Lazy (on first injection) | Errors at injection time, but faster startup | High-scale services with many singletons |

Podeum uses `DEVELOPMENT` because it surfaces misconfiguration immediately. If `DbModuleSql` can't connect to MySQL, the application crashes during `initialize()` with a clear stack trace — not 10 minutes later when the first user request triggers lazy creation of `SessionFactory`. The tradeoff (slower startup by ~2-3 seconds) is irrelevant for a gaming backend that deploys once per day.

---

## 3. The Request Filter Chain

Every HTTP request passes through a filter chain BEFORE reaching any JAX-RS resource. Podeum registers two filters:

### RequestSessionFilter: Session Validation and Context Setup

```java
public class RequestSessionFilter implements ContainerRequestFilter {

    @Override
    public void filter(ContainerRequestContext requestContext) {
        // 1. Extract JWT from Authorization header
        String authHeader = requestContext.getHeaderString(HttpHeaders.AUTHORIZATION);
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            requestContext.abortWith(
                Response.status(Response.Status.UNAUTHORIZED)
                    .entity("Missing or invalid Authorization header")
                    .build()
            );
            return;
        }

        String token = authHeader.substring("Bearer ".length());

        // 2. Validate against Firebase Auth
        FirebaseToken decodedToken = FirebaseAuth.getInstance()
            .verifyIdToken(token);

        // 3. Set userId and metadata on the security context
        SecurityContext securityContext = new PodeumSecurityContext(
            decodedToken.getUid(),
            decodedToken.getEmail(),
            decodedToken.getClaims()
        );
        requestContext.setSecurityContext(securityContext);

        // 4. Check if session is active in Redis (device binding, force-logout)
        RedisClient redis = GuiceBundle.getInjector()
            .getInstance(RedisClient.class);
        String sessionKey = "sessions:" + decodedToken.getUid();
        Map<String, String> session = redis.hgetAll(sessionKey);
        if (session == null || session.isEmpty()) {
            requestContext.abortWith(
                Response.status(Response.Status.UNAUTHORIZED)
                    .entity("Session expired or invalidated")
                    .build()
            );
            return;
        }
    }
}
```

This filter runs first. If authentication fails, the request is aborted (HTTP 401) and never reaches the JAX-RS resource. This is a **fail-fast** pattern: no point in rate-limiting or routing a request that we know is unauthenticated.

### RequestFilter: Request Logging and Response Enrichment

```java
public class RequestFilter implements ContainerRequestFilter, ContainerResponseFilter {

    private static final Logger log = LoggerFactory.getLogger(RequestFilter.class);

    // Request phase: log the incoming request
    @Override
    public void filter(ContainerRequestContext requestContext) {
        MDC.put("requestId", UUID.randomUUID().toString().substring(0, 8));
        MDC.put("userId", getUserId(requestContext));
        MDC.put("path", requestContext.getUriInfo().getPath());
        MDC.put("method", requestContext.getMethod());

        log.info("→ {} {}", requestContext.getMethod(),
                 requestContext.getUriInfo().getPath());
    }

    // Response phase: add standard headers and log completion
    @Override
    public void filter(ContainerRequestContext requestContext,
                       ContainerResponseContext responseContext) {
        responseContext.getHeaders().add("X-Request-Id", MDC.get("requestId"));
        responseContext.getHeaders().add("X-Response-Time",
            System.currentTimeMillis() - Long.parseLong(MDC.get("startTime")) + "ms");

        log.info("← {} {} → {} ({}ms)",
            requestContext.getMethod(),
            requestContext.getUriInfo().getPath(),
            responseContext.getStatus(),
            System.currentTimeMillis() - Long.parseLong(MDC.get("startTime")));

        MDC.clear();
    }
}
```

Both filters use Dropwizard's (Jersey's) `ContainerRequestFilter` and `ContainerResponseFilter` interfaces. The key pattern: `RequestSessionFilter` is request-only (it can abort), `RequestFilter` is both request and response (it logs both directions).

### The Complete Request Pipeline

```
HTTP Request
    │
    ▼
┌──────────────────────────────────────────┐
│  Jetty HTTP Server (Dropwizard)          │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  RequestSessionFilter (ContainerRequest) │
│  - Extract JWT                            │
│  - Validate Firebase token               │
│  - Check Redis session                   │
│  - Set SecurityContext or abort 401      │
└───────────────┬──────────────────────────┘
                │ (if authenticated)
                ▼
┌──────────────────────────────────────────┐
│  RequestFilter (ContainerRequest)        │
│  - Set MDC (requestId, userId, path)     │
│  - Log incoming request                   │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  RateLimitFilter (registered separately) │
│  - Extract userId + endpoint             │
│  - Increment Redis counter               │
│  - Return 429 if exceeded                │
└───────────────┬──────────────────────────┘
                │ (if not rate-limited)
                ▼
┌──────────────────────────────────────────┐
│  JAX-RS Resource (@Path handler)         │
│  - Jersey dispatches to matching method  │
│  - Business logic executes               │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  RequestFilter (ContainerResponse)       │
│  - Add X-Request-Id header               │
│  - Add X-Response-Time header            │
│  - Log response status + timing          │
│  - Clear MDC                             │
└───────────────┬──────────────────────────┘
                │
                ▼
            HTTP Response
```

Filter ordering is critical and is determined by registration order in `run()`:

```java
environment.jersey().register(new RequestSessionFilter());  // 1st
environment.jersey().register(new RequestFilter());          // 2nd
```

`RequestSessionFilter` must run first because `RequestFilter` reads the security context set by `RequestSessionFilter`. If the order were reversed, `RequestFilter` would log `userId=null` and the MDC would be useless for debugging.

---

## 4. Quartz Job Manager Integration

The Quartz scheduler is started in `run()` via `JobManager`, which is itself a Guice-managed singleton:

```java
JobManager jobManager = GuiceBundle.getInjector().getInstance(JobManager.class);
jobManager.start();
```

### Why Quartz Instead of Dropwizard Managed Objects

Dropwizard provides `Managed` objects — classes with `start()` and `stop()` methods that participate in the application lifecycle. Podeum could have wrapped each cron job as a `Managed` object that calls `ScheduledExecutorService.scheduleAtFixedRate()`.

The team chose Quartz instead for three reasons:

1. **Cron expressions, not fixed rates**: Quartz jobs are scheduled with cron expressions (`0 */5 * * * ?` for "every 5 minutes"), which are more expressive than fixed-rate scheduling. A job that runs "every day at 9:30 AM IST" is trivial in Quartz and awkward in `ScheduledExecutorService`.

2. **Job persistence**: Quartz can persist job state to MySQL (via `JobStoreTX`), meaning if a pod restarts mid-job, the job state is recovered. Podeum uses in-memory job store (`RAMJobStore`) because jobs are idempotent, but the option exists for future needs.

3. **Misfire handling**: If a job was scheduled to run at 9:30 AM but the pod was restarting, Quartz's misfire policy determines whether the job runs immediately on restart or skips to the next scheduled window. `ScheduledExecutorService` has no concept of misfire — if the executor is shut down, tasks are silently lost.

### Jobs Running on Quartz

| Job | Schedule | Purpose | Criticality |
|-----|----------|---------|-------------|
| Match state polling | Every 10 seconds | Poll SI for live match updates (fallback to webhook) | High — no scores without this |
| Leaderboard recalculation | Every 30 seconds | Recalculate fantasy leaderboards, write to Redis | High — stale leaderboards frustrate users |
| Pod status updates | Every 5 minutes | Check pod activity, mark inactive pods | Medium — affects pod discovery |
| Game reward distribution | Daily at 10:00 AM IST | Distribute daily rewards to active users | Medium — user engagement feature |
| Daily game scheduling | Daily at midnight | Create new daily quiz pods and prediction markets | High — platform content generation |
| Old game cleanup | Daily at 3:00 AM IST | Archive completed games, clean up Redis keys | Low — operational hygiene |
| S3 live feed archival | Hourly | Move raw match data from ephemeral storage to S3 glacier | Low — data retention compliance |

The `JobManager` is also a `Managed` object registered with Dropwizard's lifecycle, so it receives `stop()` on application shutdown, which calls `Scheduler.shutdown(true)` to gracefully complete in-flight jobs.

---

## 5. RSA Token for Internal Service-to-Service Auth

```java
private void setEnvVars(Environment environment) {
    // Generate RSA 2048-bit key pair
    KeyPairGenerator keyGen = KeyPairGenerator.getInstance("RSA");
    keyGen.initialize(2048);
    KeyPair pair = keyGen.generateKeyPair();

    // Base64-encode the public key as the service token
    String publicKeyBase64 = Base64.getEncoder()
        .encodeToString(pair.getPublic().getEncoded());

    // Set as system property for other modules to read
    System.setProperty("TOKEN", publicKeyBase64);
    System.setProperty("SELF_URL", environment.getProperty("selfUrl"));
    System.setProperty("ENV", System.getProperty("env", "local"));
}
```

### Why RSA Instead of a Shared Secret

When Podeum's backend needs to call itself (for async fan-out — the webhook handler fires off a request to a different resource on the same service), it needs to authenticate that the request came from the backend, not from an external client spoofing internal endpoints.

Three approaches were considered:

| Approach | Mechanism | Pros | Cons | Chosen? |
|----------|-----------|------|------|---------|
| Shared secret (HMAC) | Static string in config, included in `X-Internal-Auth` header | Simple | Secret must be shared across all pods. If one pod is compromised, all are. Secret rotation requires coordinated deploy. | No |
| JWT with internal issuer | Backend issues itself a JWT with 5-minute expiry | Standard, auditable | Requires Firebase Admin SDK to issue JWTs (adds latency). Clock skew between pods can cause 401s. | No |
| **RSA token (chosen)** | Each pod generates its own keypair at startup. Public key is the token. All pods trust tokens signed by known keys. | No shared secret. Pods can verify without calling an auth service. Key rotation is automatic (new key per startup). | All pods must know each other's public keys. At small scale (3-10 pods), this is manageable. | **Yes** |

The RSA approach works because Podeum's EKS cluster is small (3-10 pods). When `setEnvVars()` generates a keypair, other pods discover this pod's public key via Kubernetes service discovery or a shared Redis key. At 100+ pods, this approach would break down (O(n²) key exchange), but at Podeum's scale it's simpler and more secure than a shared secret.

### System Properties as Configuration Transport

The three `System.setProperty()` calls are a deliberate pattern: they make configuration available to any class in the JVM without requiring Guice injection:

```java
// Anywhere in the codebase:
String token = System.getProperty("TOKEN");
String selfUrl = System.getProperty("SELF_URL");
String env = System.getProperty("ENV");
```

This is pragmatic for three values that are (a) global, (b) immutable after startup, and (c) needed in places where injecting a configuration object would be awkward (static utility methods, filter classes instantiated by Jersey, etc.). The alternative — passing `@Named("TOKEN") String token` through every constructor — would pollute every class's constructor signature.

---

## 6. Health Check Pattern

```java
public class HealthTask extends HealthCheck {

    private final MongoClient mongoClient;

    public HealthTask(GameConfig config) {
        this.mongoClient = new MongoClient(
            new MongoClientURI(config.getMongoConfig().getUri())
        );
    }

    @Override
    protected Result check() {
        try {
            // Ping MongoDB — simplest possible health check
            mongoClient.getDatabase("admin").runCommand(
                new Document("ping", 1)
            );
            return Result.healthy("MongoDB reachable, ping OK");
        } catch (Exception e) {
            return Result.unhealthy("MongoDB unreachable: " + e.getMessage());
        }
    }
}
```

Dropwizard exposes health checks at `GET /healthcheck` (configurable path, default `/healthcheck`). Kubernetes uses this endpoint for **liveness and readiness probes**:

```yaml
# In the Kubernetes Deployment manifest:
livenessProbe:
  httpGet:
    path: /healthcheck
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /healthcheck
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
```

The distinction:
- **Liveness probe**: "Is the pod alive?" If it fails, Kubernetes restarts the pod. Checks that the HTTP server is responding and critical dependencies (MongoDB) are reachable.
- **Readiness probe**: "Should the pod receive traffic?" If it fails, Kubernetes removes the pod from the load balancer. Same endpoint, but more aggressive timing (5s vs 10s) because you want to stop routing traffic faster than you want to restart the pod.

### Why Only MongoDB Health Check?

The `HealthTask` only checks MongoDB, not MySQL or Redis. This is deliberate:

| Dependency | Health Check? | Reason |
|------------|---------------|--------|
| MongoDB | **Yes** | Critical for webhook processing (live match data). If MongoDB is down, the pod cannot process incoming cricket data — better to restart and hope the new pod connects to a healthy replica. |
| MySQL | **No (implicit)** | Hibernate connection pool has built-in connection validation (`testOnBorrow`). If MySQL is down, API calls fail with 503, but the pod stays alive to serve cached data from Redis. Restarting the pod wouldn't fix a MySQL outage. |
| Redis | **No (implicit)** | Rate limiting degrades gracefully (allows requests if Redis is down). Match state falls back to MongoDB. Restarting the pod wouldn't fix a Redis outage. |

The health check philosophy: **only report unhealthy if restarting the pod has a reasonable chance of fixing the problem.** A MongoDB connection failure might be transient (network blip, DNS resolution failure) — restarting the pod creates a new connection from a fresh TCP stack and often resolves it. A MySQL outage is an infrastructure problem that pod restarts won't fix.

---

## 7. Configuration Hierarchy: Local / Dev / Prod

Podeum maintains three configuration files per environment, stored under `runtime/config/{local,dev,prod}/`:

```
runtime/config/
├── local/
│   ├── podeum-backend-config.yml
│   ├── redission.yml
│   └── newrelic.yml
├── dev/
│   ├── podeum-backend-config.yml
│   ├── redission.yml
│   └── newrelic.yml
└── prod/
    ├── podeum-backend-config.yml
    ├── redission.yml
    └── newrelic.yml
```

### Why Three Files per Environment, Not One Monolithic Config

Each environment has three separate YAML files because they configure different subsystems with different lifecycle requirements:

| Config File | Content | Managed By | Change Frequency |
|-------------|---------|------------|------------------|
| `podeum-backend-config.yml` | Dropwizard config: server port, logging, MySQL URL, MongoDB URI, Firebase credentials path, PhonePe API keys, S3 bucket names | Developer commits to git (git-crypt encrypted) | Weekly — new features, endpoint changes |
| `redission.yml` | Redis connection: single/cluster mode, connection pool, retry policy, timeouts | Developer commits to git (git-crypt encrypted) | Monthly — performance tuning |
| `newrelic.yml` | New Relic APM: license key, app name, transaction tracing config | DevOps / Platform team | Quarterly — APM config changes |

The `newrelic.yml` is **commented out in the Dockerfile** by default (New Relic agent adds startup overhead and is only enabled in production when actively debugging). This is the pattern:

```dockerfile
# Dockerfile (excerpt)
CMD ["java", \
     "-jar", "podeum-backend.jar", \
     "server", "config/podeum-backend-config.yml"]
# Uncomment for New Relic:
# CMD ["java", \
#      "-javaagent:newrelic/newrelic.jar", \
#      "-Dnewrelic.config.file=config/newrelic.yml", \
#      "-jar", "podeum-backend.jar", \
#      "server", "config/podeum-backend-config.yml"]
```

### git-crypt Encryption

All config files are encrypted with `git-crypt`. This means:

- **In the repository**: config files are binary blobs. A GitHub leak exposes nothing usable.
- **On developer machines**: `git-crypt unlock` with the team's symmetric key decrypts the files transparently. `git diff` shows plaintext diffs. `git log -p` shows plaintext history.
- **In CI/CD (CircleCI)**: The symmetric key is stored as a CircleCI environment variable. The build step runs `git-crypt unlock` before `mvn package`.

The key never leaves three places: the two developers' laptops (via `git-crypt unlock`) and CircleCI environment variables. No AWS Secrets Manager, no HashiCorp Vault — this is the pragmatic choice for a 2-person team.

### Configuration Drift Between Environments

| Setting | Local | Dev | Prod | Why Different |
|---------|-------|-----|------|---------------|
| MySQL JDBC URL | `jdbc:mysql://localhost:3306/podeum` | `jdbc:mysql://dev-podeum.xxxxxx.ap-south-1.rds.amazonaws.com:3306/podeum_dev` | `jdbc:mysql://prod-podeum.xxxxxx.ap-south-1.rds.amazonaws.com:3306/podeum` | Different RDS instances |
| MongoDB URI | `mongodb://localhost:27017/podeum` | `mongodb://dev-mongo.xxxxxx.amazonaws.com:27017/podeum_dev` | `mongodb://prod-mongo.xxxxxx.amazonaws.com:27017/podeum` | Different DocumentDB/MongoDB clusters |
| Redis URL | `redis://localhost:6379` | `redis://dev-redis.xxxxxx.elasticache.amazonaws.com:6379` | `redis://prod-redis.xxxxxx.elasticache.amazonaws.com:6379` | Different ElastiCache clusters |
| C3P0 max pool size | 5 | 20 | 50 | Resource limits scale with environment |
| Redisson connection pool | min 2, max 8 | min 4, max 16 | min 8, max 24 | Connection pool grows with pod count |
| Quartz thread pool | 2 threads | 5 threads | 10 threads | Parallel job execution |
| Log level | DEBUG | INFO | WARN | Verbosity decreases toward production |
| New Relic | Disabled | Disabled (commented out) | Enabled (uncommented when debugging) | APM overhead only when needed |

### The Config Class: GameConfig.java

```java
public class GameConfig extends Configuration {

    @JsonProperty("mysql")
    private MySQLConfiguration mysqlConfig;

    @JsonProperty("mongo")
    private MongoConfiguration mongoConfig;

    @JsonProperty("redis")
    private RedisConfiguration redisConfig;

    @JsonProperty("firebase")
    private FirebaseConfiguration firebaseConfig;

    @JsonProperty("phonepe")
    private PhonePeConfiguration phonepeConfig;

    @JsonProperty("httpClient")
    private ClientConfiguration httpClientConfig;

    @JsonProperty("s3")
    private S3Configuration s3Config;

    @JsonProperty("selfUrl")
    private String selfUrl;

    // Getters for each sub-config
}
```

Dropwizard uses Jackson to deserialize the YAML into this POJO. The `@JsonProperty` annotations map YAML keys to Java fields. Each sub-config (e.g., `MySQLConfiguration`) is itself a POJO with `@JsonProperty` fields for host, port, database, credentials, pool size, etc.

The `GameConfig` object is bound as a Guice singleton by `ConfigModule`, making it available for injection into any class:

```java
@Inject
public SomeService(GameConfig config) {
    this.selfUrl = config.getSelfUrl();
}
```

---

## 8. ConfigModule: The Bridge Between YAML and Guice

```java
public class ConfigModule extends AbstractModule {

    private final GameConfig config;

    public ConfigModule(GameConfig config) {
        this.config = config;
    }

    @Override
    protected void configure() {
        // Bind the top-level config
        bind(GameConfig.class).toInstance(config);

        // Bind sub-configs by extracting from GameConfig
        bind(MySQLConfiguration.class).toInstance(config.getMysqlConfig());
        bind(MongoConfiguration.class).toInstance(config.getMongoConfig());
        bind(RedisConfiguration.class).toInstance(config.getRedisConfig());
        bind(FirebaseConfiguration.class).toInstance(config.getFirebaseConfig());
        bind(PhonePeConfiguration.class).toInstance(config.getPhonepeConfig());
        bind(ClientConfiguration.class).toInstance(config.getHttpClientConfig());
        bind(S3Configuration.class).toInstance(config.getS3Config());
    }
}
```

This is the simplest Guice module in the system but the most important: it's the bridge between declarative YAML configuration and all other Guice modules. Every other module injects one of these sub-config POJOs to get its connection strings, pool sizes, and API keys.

---

## 9. MultiPartFeature: File Upload Support

```java
environment.jersey().register(MultiPartFeature.class);
```

This single line enables multipart file upload support in Jersey. Without it, `@FormDataParam` annotations on resource methods would fail at runtime with a cryptic "not supported" error.

Podeum uses file uploads for:
- Profile picture uploads (stored in S3)
- Quiz pod cover images (S3)
- User-generated content (chat attachments, game screenshots)

The `MultiPartFeature` registration happens in `run()` because it's a Jersey feature that must be registered on the `ResourceConfig` — it's a runtime concern, not a dependency injection concern.

---

## Summary: What the Runtime Module Teaches

1. **Dropwizard's two-phase lifecycle (`initialize` + `run`) separates wiring from operations.** Declare bindings in `initialize` (no I/O). Register filters, health checks, and start schedulers in `run` (full I/O access). Mixing these phases leads to startup failures that are hard to debug.

2. **Nine Guice modules are better than one monolithic module.** Each module maps to exactly one external dependency or cross-cutting concern. Testability, failure isolation, and team mental model all improve. The cost (9 files instead of 1) is negligible.

3. **Filter ordering matters and is determined by registration order.** `RequestSessionFilter` must run before `RequestFilter` because it sets the security context that `RequestFilter` reads. Misordering produces `userId=null` in logs and silent authentication bypasses.

4. **Quartz beats `ScheduledExecutorService` for cron-based scheduling.** Cron expressions, job persistence, and misfire handling are all real-world needs that `ScheduledExecutorService` doesn't address. The tradeoff (Quartz is heavier, ~2MB JAR) is irrelevant at Podeum's scale.

5. **RSA token generation per pod provides zero-configuration internal service auth.** No shared secret to rotate, no external auth service dependency. Works at small scale (3-10 pods) where O(n²) key exchange is manageable.

6. **Health checks should only report unhealthy if restarting the pod might fix it.** Checking MongoDB (connection failure could be transient) but not MySQL (outage is infrastructure problem) is a deliberate scoping decision informed by Kubernetes' liveness/readiness probe behavior.

7. **Three config files per environment (not one) because different subsystems change at different velocities.** Dropwizard config changes with feature development (weekly), Redis config with performance tuning (monthly), New Relic config with APM changes (quarterly). Separating them reduces merge conflicts.

8. **git-crypt provides "good enough" secret management for a 2-person team.** No AWS Secrets Manager, no HashiCorp Vault — symmetric encryption of config files in git is sufficient when the key never leaves three machines.

---

**Next:** [Module 8: Deployment & Infrastructure](./08-deployment) — Docker, Kubernetes, AWS EKS, CircleCI  
**Previous:** [Module 6: Firebase Notifications](./06-notifications) — Push (FCM) + in-app (Firestore)
