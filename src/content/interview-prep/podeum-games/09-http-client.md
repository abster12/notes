---
title: "Module 9: HTTP Client — JAX-RS Abstraction, Generic Deserialization, and External API Communication"
date: 2026-07-09
type: article
tags: [podeum, http-client, jax-rs, jersey, deserialization, generics, external-api, system-design, fantasy-gaming]
related: [podeum-games, 07-runtime, 05-payment-gateway, 03-api-resources]
audience: [senior-engineer, system-design-interview-prep]
estimated_read_time: 18 min deep read, 9 min skim
---

# Module 9: HTTP Client — JAX-RS Abstraction, Generic Deserialization, and External API Communication

The HTTP client module (`http-client/src/main/java/com/podeum/http/`) is one of the smallest modules in Podeum — a single interface, one implementation, one configuration class, and one Guice module. But its design decisions have outsized impact because every external service call in the application flows through it: PhonePe payment processing, Sports Interactive cricket data, Firebase REST APIs for server-side operations, and internal service-to-service calls for async fan-out.

The module answers a deceptively simple question: "How should a Java backend make HTTP calls to external services?" The answer reveals deep thinking about abstraction boundaries, type safety, error handling, and the difference between a utility and a module.

---

## 1. The HttpClient Interface: A Contract, Not an Implementation

```java
public interface HttpClient {

    <T> T get(String url, Map<String, String> headers, Class<T> responseClass);

    <T> T post(String url, Map<String, String> headers, Object body, Class<T> responseClass);

}
```

Just four lines. But these four lines encode every design decision in the module:

### Decision 1: Only GET and POST

The interface exposes only `get()` and `post()`. No `put()`, `patch()`, `delete()`, `head()`, or `options()`. This is not laziness — it's a deliberate constraint:

| HTTP Method | Used in Podeum? | Why/Why Not |
|-------------|-----------------|-------------|
| GET | **Yes** — PhonePe status checks, SI match data polling, Firebase user lookup | Most external APIs are read-heavy. GET is sufficient. |
| POST | **Yes** — PhonePe payment init, SI webhook registration, Firebase custom token creation, internal async fan-out | All write operations to external APIs use JSON request bodies. POST is the universal "send data" method. |
| PUT | No | No external API Podeum integrates with uses PUT. Firebase uses PATCH for partial updates (handled via Firebase Admin SDK, not raw HTTP). |
| DELETE | No | No external API requires DELETE. Even if one did, POST with an `action: delete` body would suffice. |
| PATCH | No | Firebase uses PATCH for Firestore, but the Firebase Admin SDK abstracts this. |
| HEAD | No | Never needed to check resource existence without fetching bodies. |

The YAGNI principle in action: don't add methods until you need them. Adding `put()` "just in case" creates an untested code path that may silently fail when eventually used.

### Decision 2: Generic Return Type with Class<T>

```java
<T> T get(String url, Map<String, String> headers, Class<T> responseClass);
```

The return type is `T` — a generic parameter determined by the `responseClass` argument. This means callers never need to cast:

```java
// Caller code:
PhonePeStatusResponse status = httpClient.get(
    statusUrl,
    headers,
    PhonePeStatusResponse.class  // <-- Deserialize into this type
);
// status is already PhonePeStatusResponse — no casting
```

The alternative — returning `JsonNode` or `String` and making callers deserialize — would be:

```java
// What Podeum avoided:
String rawJson = httpClient.get(statusUrl, headers);
PhonePeStatusResponse status = objectMapper.readValue(rawJson, PhonePeStatusResponse.class);
// Every caller repeats these 2 lines. Every caller can get deserialization wrong.
```

### Decision 3: Headers as Map<String, String>

Headers are passed as a `Map<String, String>`, typically an `ImmutableMap` from Guava:

```java
Map<String, String> headers = ImmutableMap.of(
    "Content-Type", "application/json",
    "X-VERIFY", signature,
    "Accept", "application/json"
);
```

This is deliberately NOT a custom `Headers` class with typed header constants. At Podeum's scale (integrating with ~5 external APIs), a `Map<String, String>` is sufficient and avoids the overhead of maintaining an enum of known headers.

The Guava `ImmutableMap` choice is non-obvious but important: it guarantees the headers map is not accidentally mutated by the implementation or the caller after the method returns. The `ImmutableMap.of()` factory accepts up to 5 key-value pairs, which covers every external API call Podeum makes (most have 2-4 headers).

### Decision 4: No Async Variant

The interface is purely synchronous. There's no `getAsync()` returning `CompletableFuture<T>`. This is consistent with Podeum's design philosophy: async behavior is handled at the caller level using `CompletableFuture.runAsync()` or Quartz jobs, not by the HTTP client itself.

```java
// How Podeum makes fire-and-forget HTTP calls (in SportzInteractiveHandler):
CompletableFuture.runAsync(() -> {
    httpClient.post(internalUrl, headers, payload, Void.class);
});
```

This keeps the HTTP client simple and testable. Adding async variants would require:
- A thread pool configuration (how many concurrent HTTP connections?)
- Timeout semantics (what happens if an async call hangs?)
- Error handling (who catches exceptions thrown on the async thread?)

All of these are caller concerns, not HTTP client concerns.

---

## 2. HttpImplementation: The JAX-RS Client Wrapper

```java
@Singleton
public class HttpImplementation implements HttpClient {

    private final javax.ws.rs.client.Client client;
    private final ObjectMapper objectMapper;
    private final ClientConfiguration config;

    @Inject
    public HttpImplementation(ClientConfiguration config) {
        this.config = config;
        this.client = ClientBuilder.newBuilder()
            .connectTimeout(config.getConnectTimeoutMs(), TimeUnit.MILLISECONDS)
            .readTimeout(config.getReadTimeoutMs(), TimeUnit.MILLISECONDS)
            .build();
        this.objectMapper = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    @Override
    public <T> T get(String url, Map<String, String> headers, Class<T> responseClass) {
        Invocation.Builder request = client.target(url)
            .request(MediaType.APPLICATION_JSON);

        // Apply headers
        for (Map.Entry<String, String> header : headers.entrySet()) {
            request.header(header.getKey(), header.getValue());
        }

        Response response = request.get();
        return parseResponse(response, responseClass);
    }

    @Override
    public <T> T post(String url, Map<String, String> headers, Object body,
                       Class<T> responseClass) {
        Invocation.Builder request = client.target(url)
            .request(MediaType.APPLICATION_JSON);

        // Apply headers
        for (Map.Entry<String, String> header : headers.entrySet()) {
            request.header(header.getKey(), header.getValue());
        }

        // Serialize body to JSON
        Entity<String> jsonEntity = Entity.entity(
            objectMapper.writeValueAsString(body),
            MediaType.APPLICATION_JSON
        );

        Response response = request.post(jsonEntity);
        return parseResponse(response, responseClass);
    }

    private <T> T parseResponse(Response response, Class<T> responseClass) {
        String responseBody = response.readEntity(String.class);

        if (response.getStatus() >= 400) {
            throw new ExternalApiException(
                response.getStatus(),
                responseBody,
                "HTTP " + response.getStatus() + " from external API"
            );
        }

        if (responseClass == Void.class || responseBody == null
            || responseBody.isEmpty()) {
            return null;
        }

        return objectMapper.readValue(responseBody, responseClass);
    }
}
```

### Why JAX-RS Client and Not...

| Alternative | Why Rejected |
|-------------|-------------|
| **Apache HttpClient** | More powerful (connection pooling, retry, circuit breaking), but requires ~2MB of dependencies and a steeper learning curve. JAX-RS Client is already on the classpath (Dropwizard depends on Jersey, which includes `javax.ws.rs-client`). Zero additional dependencies. |
| **OkHttp** | Excellent library, but adds a third-party dependency to a codebase that already has two HTTP clients (JAX-RS for server, OkHttp for client). JAX-RS Client does everything Podeum needs. |
| **Spring RestTemplate** | Requires Spring Web dependency. Podeum is a Dropwizard/Guice shop — adding Spring for just an HTTP client is architecturally inappropriate. |
| **Java 11 HttpClient** | Podeum targets Java 8 (the standard at the time of development). The new `java.net.http.HttpClient` wasn't available. Even if it were, JAX-RS Client provides better integration with Jackson (no manual JSON parsing). |
| **Raw HttpURLConnection** | No connection pooling, verbose API, no JSON support. Absolute non-starter for a production system making thousands of external calls per day. |

The decision came down to: **JAX-RS Client is already on the classpath, does everything we need, and the team already knows its API from writing JAX-RS server code.** Adding another HTTP library would solve zero problems and create one (dependency management).

### The ObjectMapper Configuration

```java
this.objectMapper = new ObjectMapper()
    .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
```

`FAIL_ON_UNKNOWN_PROPERTIES = false` is critical for external API resilience. When PhonePe adds a new field to their API response (e.g., `"merchantTransactionId_v2": "..."`), Podeum's DTOs won't have that field. Without this configuration, deserialization would throw `UnrecognizedPropertyException` and every PhonePe transaction would fail until the DTO is updated.

Setting this to `false` means:
- **Unknown fields are silently ignored.** The DTO deserializes successfully with all known fields populated.
- **Missing fields get default values** (null for objects, 0 for primitives, false for booleans). This is acceptable because Podeum only reads fields it cares about.
- **The tradeoff**: If PhonePe renames a field (e.g., `transactionId` → `txnId`), Podeum won't crash, but the DTO's `transactionId` will silently be null. This is caught by integration tests that validate the full DTO against recorded API responses.

---

## 3. Generic Type Deserialization: Why Class<T> and Not TypeReference<T>

The interface uses `Class<T>` for the response type, not Jackson's `TypeReference<T>`:

```java
// Podeum's approach: Class<T>
PhonePeStatusResponse status = httpClient.get(url, headers, PhonePeStatusResponse.class);

// Alternative (rejected): TypeReference<T>
PhonePeStatusResponse status = httpClient.get(url, headers,
    new TypeReference<PhonePeStatusResponse>() {});
```

### Why Class<T> Works (and TypeReference<T> Is Unnecessary)

`Class<T>` works for Podeum because **every external API response deserializes to a concrete class, never a generic type.** The response structures are:

```java
// Concrete classes — Class<T> works perfectly
class PhonePeInitResponse { ... }
class PhonePeStatusResponse { ... }
class SIMatchFeedResponse { ... }
class FirebaseUserResponse { ... }

// Never needed: generic response wrappers
class ApiResponse<T> {  // Podeum doesn't use this pattern
    private T data;
    private String status;
}
```

If Podeum ever needed to deserialize to a generic type (e.g., `ApiResponse<PhonePeStatusResponse>`), `Class<T>` would fail at runtime because of Java type erasure — Jackson wouldn't know what `T` is. `TypeReference` preserves generic type information through a workaround (anonymous subclass captures the type parameter).

But Podeum's external APIs don't use generic wrappers. PhonePe's API returns `{"success": true, "data": {...}}` where `{...}` is different for every endpoint, but Podeum creates a separate DTO per endpoint (`PhonePeInitResponse`, `PhonePeStatusResponse`) rather than one generic `PhonePeResponse<T>`. This means `Class<T>` is sufficient.

### What Happens Internally

```java
// Inside HttpImplementation:
return objectMapper.readValue(responseBody, responseClass);
```

Jackson's `readValue(String, Class<T>)` inspects the class at runtime via reflection. For `PhonePeStatusResponse.class`, it:
1. Reads the JSON string
2. Identifies that the target type is `PhonePeStatusResponse`
3. Iterates over the class's fields (via getters or `@JsonProperty` annotations)
4. Maps JSON keys to Java field names
5. Deserializes nested objects recursively

No type erasure issues because `PhonePeStatusResponse` is a concrete class — there's nothing to erase.

---

## 4. Error Handling: ExternalApiException

```java
public class ExternalApiException extends RuntimeException {

    private final int statusCode;
    private final String responseBody;

    public ExternalApiException(int statusCode, String responseBody, String message) {
        super(message);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }

    public int getStatusCode() { return statusCode; }
    public String getResponseBody() { return responseBody; }
}
```

### Why an Unchecked Exception (RuntimeException)

This is a deliberate design choice with clear tradeoffs:

| Checked Exception | Unchecked Exception (Podeum's choice) |
|-------------------|--------------------------------------|
| Callers MUST catch or declare | Callers MAY catch if they can recover |
| Forces error handling at every call site | Allows errors to propagate to a global exception mapper |
| Pollutes method signatures (`throws ExternalApiException`) | Clean signatures — HTTP failure is treated like NPE (unexpected, fatal) |
| Good for recoverable errors (retry, fallback) | Good for unrecoverable errors (external service is down) |

Podeum treats external API failures as **unrecoverable at the HTTP client level.** If PhonePe returns 500, there's nothing the HTTP client can do — retry logic, circuit breaking, and fallback behavior are caller concerns. The HTTP client's job is to (a) make the request, (b) parse a successful response, or (c) throw an exception with enough context for the caller to decide what to do.

### Where ExternalApiException Is Caught

| Caller | Recovery Strategy |
|--------|------------------|
| `PhonePeClient.init()` | Catches `ExternalApiException`, logs the error with transaction ID, returns `PaymentInitResponse.failed()` with the error code. The Flutter client shows "Payment failed, please try again" to the user. |
| `PhonePeClient.checkStatus()` | Catches, retries up to 3 times with exponential backoff (1s, 2s, 4s). If all retries fail, returns `PaymentStatusResponse.unknown()`. The client retries on next poll. |
| `SportzInteractiveHandler` (SI webhook registration) | Catches, logs warning, skips webhook registration for this cycle. Will retry on next Quartz invocation (every 5 minutes). |
| Internal async fan-out | **Does not catch.** `CompletableFuture.runAsync()` wraps the call — if it throws, the future completes exceptionally. No one inspects the future (fire-and-forget), so the exception is silently swallowed. This is acceptable because internal fan-out is best-effort (the original request already returned 202 Accepted). |

### Audit Trail via MDC

Before `ExternalApiException` is thrown, the `HttpImplementation` logs the full request/response context:

```java
log.error("External API call failed: {} {} → {} {} | Response: {}",
    method, url, response.getStatus(), response.getStatusInfo().getReasonPhrase(),
    responseBody.length() > 500
        ? responseBody.substring(0, 500) + "..."
        : responseBody
);
```

This log entry, combined with MDC context (requestId, userId from `RequestFilter`), creates an audit trail: "Which user action triggered which external API call that failed with what response?" Without this, debugging a PhonePe payment failure would require correlating timestamps across two separate logging systems.

---

## 5. ClientConfiguration: Timeouts and Connection Pool

```java
public class ClientConfiguration {

    private int connectTimeoutMs = 5000;      // 5 seconds to establish TCP connection
    private int readTimeoutMs = 30000;        // 30 seconds to receive response
    private int maxConnections = 20;          // Max concurrent connections
    private int maxConnectionsPerRoute = 10;  // Max concurrent to same host

    // Getters and @JsonProperty annotations for YAML deserialization
}
```

### Timeout Rationale

| Setting | Value | Why |
|---------|-------|-----|
| Connect timeout | 5 seconds | Establishing a TCP connection to an external host should take under 1 second in normal conditions. 5 seconds accounts for DNS resolution + TCP handshake + TLS handshake even under degraded network conditions. If it takes longer, something is fundamentally wrong (host unreachable, DNS down, network partition). |
| Read timeout | 30 seconds | PhonePe payment processing can take 15-20 seconds (user enters UPI PIN on their phone app, bank processes the transaction). 30 seconds gives a 10-second buffer. For SI match data (sub-second responses), 30 seconds is generous but harmless — the response arrives in under 100ms. |
| Max connections | 20 | Sized for peak load: 10 concurrent PhonePe transactions + 5 SI webhook registrations + 3 Firebase calls + 2 internal fan-outs. 20 connections is ~2% of the total MySQL connection pool (C3P0 default is 100), reflecting that external HTTP is less resource-intensive than database queries. |
| Max per route | 10 | PhonePe is the only host that gets >3 concurrent connections. 10 per route means PhonePe can handle 10 concurrent transactions while SI and Firebase each get their share of the remaining 10. |

### Configuration in YAML

```yaml
# podeum-backend-config.yml (excerpt)
httpClient:
  connectTimeoutMs: 5000
  readTimeoutMs: 30000
  maxConnections: 20
  maxConnectionsPerRoute: 10
```

The defaults in `ClientConfiguration` mean these values only need to be specified in the YAML if they differ from defaults. In practice, `local` and `dev` environments use the defaults, and only `prod` overrides `maxConnections` to 50 (for match-day traffic spikes).

---

## 6. ClientModule: Guice Binding

```java
public class ClientModule extends AbstractModule {

    @Override
    protected void configure() {
        bind(HttpClient.class)
            .to(HttpImplementation.class)
            .in(Singleton.class);
    }
}
```

Three lines. But they encode the most important design decision in the module: **the interface (`HttpClient`) is the Guice binding key, not the implementation (`HttpImplementation`).**

### Why Bind to Interface, Not Implementation

```java
// This is what Podeum does:
bind(HttpClient.class).to(HttpImplementation.class).in(Singleton.class);

// This is what Podeum deliberately avoided:
bind(HttpImplementation.class).in(Singleton.class);
```

The difference:

| Binding Style | Testability | Swappability | Clarity |
|--------------|-------------|--------------|---------|
| `bind(HttpClient.class).to(HttpImplementation.class)` | Tests can bind `HttpClient` to a mock/stub without touching `HttpImplementation` | Can swap to `OkHttpImplementation` without changing any callers | Explicit: "we depend on the abstraction, not the implementation" |
| `bind(HttpImplementation.class)` | Tests must mock `HttpImplementation` directly (tight coupling to implementation details) | Callers must change their `@Inject` annotation to use the new implementation | Implicit: "we depend on this specific class" |

Podeum's choice follows the Dependency Inversion Principle: high-level modules (service layer) depend on the `HttpClient` abstraction, not on `HttpImplementation`. This is what makes the service layer testable — unit tests inject a mock `HttpClient` that returns canned JSON responses without making real network calls.

### Singleton Scope

```java
.in(Singleton.class);
```

The HTTP client is a singleton because:
1. `javax.ws.rs.client.Client` instances are expensive (they maintain connection pools, thread pools, and SSL contexts).
2. Connection pooling only works if the same `Client` instance is reused across requests.
3. Thread-safety: JAX-RS Client is thread-safe by specification, so a single instance can be shared across all request threads.

---

## 7. Why a Separate HTTP Module Instead of Inline Calls

This is the most important architectural question the module answers: **"Why create an entire Maven module with an interface, implementation, config, and Guice module — instead of just calling `ClientBuilder.newClient().target(url).request().get()` inline in the service layer?"**

### The Case for Inline JAX-RS Calls

Many codebases do exactly this:

```java
// Inline approach (what Podeum rejected):
public class PhonePeClient {
    public PaymentInitResponse init(PaymentRequest request) {
        Client client = ClientBuilder.newClient();
        Response response = client.target(phonePeUrl)
            .request()
            .header("X-VERIFY", signRequest(request))
            .post(Entity.json(request));
        return response.readEntity(PaymentInitResponse.class);
    }
}
```

This works. It's fewer lines of code. It's fewer files to navigate. So why didn't Podeum do it?

### Reason 1: Configuration Centralization

With inline calls, every service configures its own `ClientBuilder`:

```java
// In PhonePeClient:
Client client = ClientBuilder.newBuilder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build();

// In SportzInteractiveHandler:
Client client = ClientBuilder.newBuilder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(10, TimeUnit.SECONDS)  // Different!
    .build();

// In FirebaseClient:
Client client = ClientBuilder.newBuilder()
    .connectTimeout(3, TimeUnit.SECONDS)  // Different again!
    .build();
```

Three different timeout configurations for three different external services. When ops says "increase all timeouts by 5 seconds for the degraded network", you have to find and modify three code locations. With a centralized `ClientConfiguration`, it's one change in `podeum-backend-config.yml`.

### Reason 2: Error Handling Consistency

Every external API call should fail the same way: log the error, throw `ExternalApiException` with status code and response body, let the caller decide what to do. With inline calls, each service writes its own error handling:

```java
// PhonePeClient error handling:
if (response.getStatus() >= 400) {
    log.error("PhonePe returned {}", response.getStatus());
    throw new RuntimeException("PhonePe error");
}

// FirebaseClient error handling:
if (response.getStatus() != 200) {
    // Oops — forgot to log the error
    return null;  // Silent failure
}
```

With a centralized `HttpImplementation`, error handling is written once and enforced everywhere.

### Reason 3: Testability

Testing a service that makes inline JAX-RS calls requires one of:
- **Mocking static methods** (not possible in plain Java without PowerMock/EasyMock extensions)
- **Running a mock HTTP server** (WireMock, MockServer) — heavyweight for unit tests
- **Dependency injection of a mock `Client`** — requires the `Client` to be injectable, which requires a module

With `HttpClient` as an injectable interface:

```java
@Test
public void testPhonePePayment() {
    HttpClient mockHttp = mock(HttpClient.class);
    when(mockHttp.post(any(), any(), any(), eq(PhonePeInitResponse.class)))
        .thenReturn(new PhonePeInitResponse(true, "txn_123"));

    PhonePeClient client = new PhonePeClient(mockHttp, config);
    PaymentInitResponse result = client.init(request);

    assertTrue(result.isSuccess());
    verify(mockHttp).post(eq("https://api.phonepe.com/..."), any(), any(),
        eq(PhonePeInitResponse.class));
}
```

This test runs in milliseconds with zero network I/O. It verifies that `PhonePeClient` calls the right URL with the right headers and correctly handles the response. Inline JAX-RS calls would make this test impossible without a mock HTTP server.

### Reason 4: Future Swappability (YAGNI, but Earned)

Podeum has never swapped `HttpImplementation` for another implementation. But the option exists and has been useful:

When debugging PhonePe integration issues in the staging environment, the team temporarily bound a `LoggingHttpClient` that wraps `HttpImplementation` and logs every request/response body in full (not truncated to 500 characters). This was done by changing one line in `ClientModule`:

```java
// Debugging binding (3 lines changed, reverted after debugging):
bind(HttpClient.class)
    .toInstance(new LoggingHttpClient(new HttpImplementation(config)));
```

No changes to `PhonePeClient`, `SportzInteractiveHandler`, or any other caller. The interface abstraction paid for itself in developer-hours saved during that debugging session.

### The Real Answer: Conway's Law

The HTTP module exists as a separate Maven module because it maps to a **boundary between concerns.** The engineers writing `PhonePeClient` care about UPI payment flows, SHA256 signing, and transaction state machines. They shouldn't have to care about JAX-RS `ClientBuilder` timeouts, connection pool sizing, or JSON deserialization error handling. The HTTP module gives them a clean contract: "Give me a URL, headers, and a response type — I'll handle the rest."

This is Conway's Law in microcosm: the code structure reflects the cognitive boundaries between problems. HTTP communication is a different problem from payment processing or cricket data ingestion, so it gets its own module with its own interface, implementation, and configuration.

---

## 8. The Internal Service-to-Service Call Pattern

One of the most interesting uses of `HttpClient` is for **internal service-to-service calls** — when one part of the backend needs to call another part of the same backend.

### Why Would a Backend Call Itself?

The webhook handler (`SportzInteractiveHandler`) processes incoming cricket data and needs to trigger multiple asynchronous operations:

```java
// Inside SportzInteractiveHandler.accept():
CompletableFuture.runAsync(() -> {
    // Fan-out: call another resource on the same backend
    String internalUrl = System.getProperty("SELF_URL")
        + "/api/fantasy/recalculate-scores";

    Map<String, String> headers = ImmutableMap.of(
        "Authorization", "Bearer " + System.getProperty("TOKEN"),
        "Content-Type", "application/json"
    );

    httpClient.post(internalUrl, headers, scoreRequest, Void.class);
});
```

This pattern avoids several problems:

| Alternative | Problem |
|-------------|---------|
| Direct method call | Couples webhook handler to fantasy score service. Both run in the same thread — if score calculation takes 5 seconds, the webhook response takes 5 seconds. |
| Event bus (Guava EventBus) | In-process, so no thread isolation. If score calculation throws, the event bus dispatcher thread dies. |
| Message queue (SQS, Kafka) | Infrastructure dependency. Adds ~50ms latency. Overkill for a single backend calling itself. |
| **HTTP to self (chosen)** | Uses existing HTTP infrastructure. Thread isolation (Jersey thread pool handles the request). Failure isolation (if score calculation fails, webhook handler is unaffected). Service-to-service auth via RSA token. |

### The SELF_URL System Property

```java
System.setProperty("SELF_URL", environment.getProperty("selfUrl"));
```

`SELF_URL` is set in `GameApplication.setEnvVars()` and read from the Dropwizard config file. In development, it's `http://localhost:8080`. In production, it's the Kubernetes service DNS name (`http://podeum-backend.default.svc.cluster.local:8080`).

Using `SELF_URL` instead of `localhost` is important because:
- In Kubernetes, `localhost` refers to the pod's container, not the service.
- The pod may not know its own IP address (dynamic allocation).
- The Kubernetes service DNS name resolves to all healthy pods, providing basic load balancing for internal calls.

### The TOKEN for Internal Auth

The RSA public key (base64-encoded) is used as a Bearer token:

```java
headers.put("Authorization", "Bearer " + System.getProperty("TOKEN"));
```

When the internal request hits the backend, `RequestSessionFilter` intercepts it. Instead of validating via Firebase (which would fail — this isn't a user token), the filter checks if the token matches any known pod's RSA public key (stored in a shared Redis set that each pod registers on startup).

This is a lightweight alternative to mTLS or SPIFFE — suitable for a small cluster where:
1. Pods trust each other (same security boundary)
2. The token is rotated on every pod restart (new RSA keypair each time)
3. The token never leaves the cluster network (internal DNS only)

---

## Summary: What the HTTP Client Module Teaches

1. **A 4-line interface can encode every design decision that matters.** `HttpClient` declares GET and POST only (YAGNI), generic return types (type safety), headers as `Map<String, String>` (simplicity), and synchronous-only (caller handles async). Each omission is as deliberate as each inclusion.

2. **JAX-RS Client is sufficient when it's already on the classpath.** Dropwizard includes Jersey, which includes `javax.ws.rs-client`. Adding OkHttp or Apache HttpClient would add a dependency without solving a problem JAX-RS Client can't handle. Know your transitive dependencies before adding new ones.

3. **`Class<T>` works for deserialization when external APIs return concrete types.** If PhonePe returned `ApiResponse<Transaction>` (generic wrapper), `Class<T>` would fail due to type erasure. But PhonePe doesn't, so the simpler approach wins.

4. **`FAIL_ON_UNKNOWN_PROPERTIES = false` is a resilience toggle, not a lazy default.** External APIs add fields without notice. Crashing on every new field is operationally irresponsible. The tradeoff (silently ignoring renamed fields) is mitigated by integration tests.

5. **A separate HTTP module is justified by configuration centralization, error handling consistency, and testability — not by "we might swap implementations."** The implementation hasn't been swapped in years, but the interface has paid for itself in testability and debuggability.

6. **Internal service-to-service calls via HTTP provide thread isolation and failure isolation without adding infrastructure.** No message queue needed. The same HTTP client, same auth mechanism, same error handling — just pointed at `SELF_URL`.

7. **Conway's Law at module granularity:** Separate modules for separate concerns (HTTP communication vs. payment processing vs. cricket data ingestion) reflect the team's cognitive boundaries and make the codebase navigable for a 2-person team.

---

**Next:** [Back to Index](./index) — Complete module map and architecture overview  
**Previous:** [Module 7: Runtime & Bootstrap](./07-runtime) — Application lifecycle, Guice wiring, filter pipeline
