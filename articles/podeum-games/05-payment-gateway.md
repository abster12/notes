---
title: "Module 5: PhonePe Payment Gateway — UPI Integration, SHA256 Signing, and Async Verification"
date: 2026-07-09
type: article
tags: [podeum, phonepe, upi, payment-gateway, sha256, system-design, fantasy-gaming, fintech]
related: [podeum-games, 01-sql-database, 04-caching, 07-runtime]
audience: [senior-engineer, system-design-interview-prep]
estimated_read_time: 22 min deep read, 10 min skim
---

# Module 5: PhonePe Payment Gateway — UPI Integration, SHA256 Signing, and Async Verification

The payment-gateway module (`payment-gateway/src/main/java/com/podeum/pg/`) is Podeum's bridge to real money. Every user who buys coins, joins a paid pod, or enters a cash contest routes through exactly one external provider: **PhonePe UPI**. This module encapsulates the entire integration — request signing, HTTP calls, status polling, webhook handling, and idempotency guarantees — behind a clean interface that makes the payment provider swappable without touching a single line of economy or fantasy code.

At Podeum's scale (10K DAU, peak usage during IPL weekends), the payment flow handles hundreds of UPI transactions per hour. Every transaction is real money moving from a user's bank account into Podeum's virtual economy. Getting any part of this wrong — double-charging, losing a payment confirmation, exposing the merchant key — is a company-ending event. This module was designed accordingly.

The module lives at `payment-gateway/src/main/java/com/podeum/pg/` and is organized into:

```
com.podeum.pg/
├── Payment.java                          // Interface: init(), checkStatus()
├── implementations/
│   └── UpiPayment.java                   // PhonePe implementation
├── configs/
│   └── PhonePeConfig.java                // Dropwizard config binding
├── mappers/
│   └── UpiMapper.java                    // Request/response transformations
├── requests/
│   ├── PayRequest.java                   // Internal payment request DTO
│   └── PhonPeUpiRequest.java            // PhonePe-specific request format
├── responses/
│   ├── PayResponse.java                  // Internal payment response DTO
│   ├── PhonePeUpiResponse.java          // PhonePe init response
│   └── PhonePeStatus.java               // PhonePe status check response
└── modules/
    └── PaymentGatewayModule.java         // Guice bindings
```

---

## 1. Why PhonePe: The UPI Provider Decision

Before diving into implementation, the business context matters. India's UPI ecosystem has three dominant players: **PhonePe (~48% market share)**, **Google Pay (~34%)**, and **Paytm (~11%)**. Podeum chose PhonePe for three concrete reasons:

### 1.1 Market Dominance in the Target Demographic

Podeum's user base — Indian cricket fans aged 18-35, primarily on Android, comfortable with UPI — overlaps almost perfectly with PhonePe's user demographic. PhonePe processes over 6 billion UPI transactions monthly in India. For a fantasy gaming platform targeting this audience, PhonePe is the path of least friction: the user already has the app installed, already trusts it, and already has their bank account linked.

### 1.2 Merchant API Maturity

PhonePe's merchant integration API (v1 at the time of Podeum's build, 2019-2020) was significantly more mature than Google Pay's merchant offerings. It provided:

- A well-documented SHA256 + salt signing mechanism
- Base64-encoded JSON payloads for request integrity
- A dedicated status-check endpoint with signed URL paths
- Webhook callbacks for asynchronous payment confirmation
- A sandbox environment with test UPI IDs

Google Pay's merchant API at the time was more focused on in-app purchases (Google Play Billing) rather than direct UPI collection requests. Paytm's API required wallet integration, which Podeum explicitly avoided — they wanted direct bank-to-bank UPI, not a stored-value wallet.

### 1.3 Single-Provider Simplicity

With a team of 2 backend engineers, supporting multiple payment providers was a non-starter. Each UPI provider has different signing mechanisms, different response formats, different webhook contracts, and different error modes. Supporting PhonePe + Google Pay would double the integration surface with no proportional revenue gain — PhonePe alone covers ~90% of the UPI user base in Podeum's target segments.

The team did design for future swappability (via the `Payment` interface — see Section 2), but they shipped with exactly one implementation: `UpiPayment`.

### Tradeoff: Vendor Lock-In

The obvious tradeoff is dependence on a single payment provider. If PhonePe changes its API, raises its merchant fees, or experiences an outage, Podeum's entire real-money economy stops. The mitigation is the `Payment` interface abstraction — switching to Google Pay or Razorpay would require writing a new implementation class, not redesigning the payment flow. The Guice module (`PaymentGatewayModule`) binds `Payment.class` to `UpiPayment.class` — changing that one binding and providing a new config section is all that's needed at the DI level.

---

## 2. Interface-Based Design: The `Payment` Contract

The cornerstone of the module is the `Payment` interface. It defines exactly three operations, and every payment provider implementation must satisfy them:

```java
public interface Payment {
    /**
     * Initialize a payment request with the payment provider.
     * Returns a provider-specific response that includes a redirect URL
     * or deep-link for the user to complete the payment in their UPI app.
     */
    PayResponse init(PayRequest payRequest);

    /**
     * Check the status of a previously initiated payment.
     * Called both by the client (polling) and by the webhook handler
     * (after receiving an async callback from the provider).
     */
    PayResponse checkStatus(String requestId);

    /**
     * Verify that an incoming webhook is genuinely from the payment provider
     * and not a malicious third party. Used in the webhook callback handler
     * to prevent payment spoofing attacks.
     */
    boolean isAuthorized(String encodedValue, String token);
}
```

### Why Three Methods?

The API surface was deliberately kept minimal. Here's what each method enables and what was intentionally excluded:

| Method | Purpose | Why It's Necessary |
|--------|---------|-------------------|
| `init()` | Start the payment flow | Every payment starts here. Returns a deep-link URL that the Flutter client opens in PhonePe. |
| `checkStatus()` | Verify payment completion | UPI payments are asynchronous. The user might complete the payment in PhonePe but the app needs to confirm before crediting coins. Polled by client + triggered by webhook. |
| `isAuthorized()` | Webhook authentication | PhonePe sends `X-VERIFY` + `X-MERCHANT-ID` headers. Without verification, anyone could POST a fake "payment succeeded" payload and get free coins. |

**What's NOT in the interface:** Refunds, cancellations, payment method listing, partial captures, recurring payments. These are all valid payment operations — but Podeum didn't need them. UPI payments are instant and irreversible; there's no "authorize then capture" flow like credit cards. Keeping the interface to three methods means every implementation is testable with three mock methods.

### Swappability in Practice

The Guice module binds the interface to the implementation:

```java
public class PaymentGatewayModule extends AbstractModule {
    @Override
    protected void configure() {
        bind(Payment.class).to(UpiPayment.class).in(Singleton.class);
        bind(PhonePeConfig.class).in(Singleton.class);
        bind(UpiMapper.class).in(Singleton.class);
    }
}
```

The rest of the Podeum codebase never references `UpiPayment` directly. The economy service, the pod join flow, the coin purchase endpoint — they all inject `Payment`:

```java
@RequiredArgsConstructor(onConstructor = @_(@Inject))
public class EconomyService {
    private final Payment payment;  // Interface, not UpiPayment
    // ...
}
```

If Podeum ever adds Razorpay or Google Pay, the change is:
1. Write `RazorpayPayment implements Payment`
2. Change `bind(Payment.class).to(RazorpayPayment.class)` in the module
3. Add Razorpay config to the Dropwizard YAML

No economy code changes. No fantasy code changes. No test rewrites. This is the power of interface-based design for external integrations — and it cost nothing to build since `UpiPayment` was the only implementation from day one.

---

## 3. SHA256 + Salt Signing: The PhonePe Authentication Mechanism

This is the most security-critical code in the entire Podeum codebase. PhonePe's API requires every request to be cryptographically signed using a merchant-specific key and salt. The signing mechanism is non-negotiable — get it wrong and PhonePe rejects the request. Get the key management wrong and attackers can forge payment confirmations.

### 3.1 The Signing Algorithm

The `UpiPayment` class implements signing via a private `getHash()` method:

```java
/**
 * Compute the SHA256 hash used for PhonePe request authentication.
 *
 * @param value   The payload to sign (base64-encoded JSON for init,
 *                the URL path for status checks)
 * @param api     The API endpoint identifier (payApi for init,
 *                statusApi for status checks)
 * @return        "{sha256hex}###{keyIndex}"
 */
private String getHash(String value, String api) {
    // Step 1: Concatenate the payload, API endpoint, and merchant key
    String input = value + api + phonePeConfig.getKey();

    // Step 2: SHA-256 hash the concatenated string
    String sha256hex = Hashing.sha256()
        .hashString(input, StandardCharsets.UTF_8)
        .toString();

    // Step 3: Append the key index as a suffix with "###" separator
    return sha256hex + "###" + phonePeConfig.getKeyIndex();
}
```

The three inputs to the hash:

| Input | Source | Example |
|-------|--------|---------|
| `value` | The payload or URL path being signed | Base64-encoded JSON body (for init) or `/v3/merchant/{id}/{txnId}` (for status) |
| `api` | The PhonePe API endpoint identifier from config | `"/v3/merchant/init"` or `"/v3/merchant/status"` |
| `key` | The merchant's secret API key (stored in Dropwizard config, never in source code) | `"a1b2c3d4-..."` |

The output format `{sha256hex}###{keyIndex}` is PhonePe's prescribed format. The `###` separator and key index suffix tell PhonePe which version of the merchant key was used (supporting key rotation). The hash itself is a standard SHA-256 digest of the concatenated string.

### 3.2 How init() Uses the Hash

When a user initiates a payment, here's the full signing flow:

```java
@Override
public PayResponse init(PayRequest payRequest) {
    // Step 1: Map internal PayRequest → PhonePe's expected format
    PhonPeUpiRequest phonePeRequest = upiMapper.toPhonePeRequest(payRequest);

    // Step 2: Serialize to JSON and base64-encode
    String payload = encode(phonePeRequest);  // Base64(JSON)

    // Step 3: Sign the base64-encoded payload
    String hash = getHash(payload, phonePeConfig.getPayApi());

    // Step 4: Build the PhonePe request JSON
    // The payload is actually wrapped in a JSON object:
    // { "request": "<base64-encoded-payload>" }
    String requestBody = mapper.writeValueAsString(
        ImmutableMap.of("request", payload)
    );

    // Step 5: Set headers
    // X-VERIFY: {sha256hash}###{keyIndex}
    // Content-Type: application/json
    // X-MERCHANT-ID: {merchantId}
    Map<String, String> headers = ImmutableMap.of(
        "X-VERIFY", hash,
        "Content-Type", "application/json",
        "X-MERCHANT-ID", phonePeConfig.getMerchantId()
    );

    // Step 6: POST to PhonePe endpoint
    String response = httpClient.post(
        phonePeConfig.getEndpoint() + phonePeConfig.getPayApi(),
        requestBody,
        headers
    );

    // Step 7: Map PhonePe response → internal PayResponse
    PhonePeUpiResponse phonePeResponse =
        mapper.readValue(response, PhonePeUpiResponse.class);
    return upiMapper.toPayResponse(phonePeResponse);
}
```

The critical detail: **the hash is computed over the base64-encoded payload, not the raw JSON.** This means the payload is protected against tampering in transit — if an attacker modifies the JSON body before it reaches PhonePe, the `X-VERIFY` header won't match and PhonePe rejects the request. Base64 encoding ensures the payload is a clean ASCII string for hashing (no encoding ambiguity from JSON special characters).

### 3.3 How checkStatus() Uses the Hash

Status checks use a different signing pattern — the hash is computed over the URL path, not the request body:

```java
@Override
public PayResponse checkStatus(String requestId) {
    // Step 1: Build the status URL with merchant and transaction IDs
    String statusPath = phonePeConfig.getStatusApi()
        .replace("{merchantId}", phonePeConfig.getMerchantId())
        .replace("{merchantTransactionId}", requestId);

    // Step 2: Sign the URL PATH (not a body — GET request has no body)
    String hash = getHash(statusPath, phonePeConfig.getStatusApi());

    // Step 3: Set headers (same pattern as init, but for GET)
    Map<String, String> headers = ImmutableMap.of(
        "X-VERIFY", hash,
        "Content-Type", "application/json",
        "X-MERCHANT-ID", phonePeConfig.getMerchantId()
    );

    // Step 4: GET from PhonePe status endpoint
    String response = httpClient.get(
        phonePeConfig.getEndpoint() + statusPath,
        headers
    );

    // Step 5: Parse and map the response
    PhonePeStatus status = mapper.readValue(response, PhonePeStatus.class);
    return upiMapper.toPayResponse(status, requestId);
}
```

This is the **only GET request** in Podeum that requires cryptographic signing. Most REST APIs authenticate GET requests with an API key in a header (like `Authorization: Bearer {token}`). PhonePe's requirement to sign the URL path on a GET request is unusual — but it ensures that status checks are authenticated even if an attacker intercepts the URL.

### 3.4 Why SHA256 + Salt and Not HMAC or JWT?

PhonePe's spec could have used:
- **HMAC-SHA256**: Standard for API signing (AWS SigV4, Stripe webhooks)
- **JWT with RS256**: Asymmetric — merchant signs with private key, PhonePe verifies with public key
- **Plain SHA256 + salt**: What PhonePe actually chose

The difference between SHA256 + salt and HMAC-SHA256 is subtle but important. HMAC-SHA256 = `SHA256(key XOR opad || SHA256(key XOR ipad || message))` — it uses the key as part of the hash construction via XOR padding, making it resistant to length-extension attacks. Plain SHA256(`message` + `key`) is technically vulnerable to length-extension attacks if the attacker knows the hash of a message and can append data.

However, PhonePe's format appends the key **at the end** of the input string (`value + api + key`), and the hash covers the full concatenation. In practice, length-extension attacks are not viable here because:
1. The `value` (base64-encoded JSON) has a known, fixed structure — an attacker can't meaningfully extend it
2. The `key` is at the end of the input, making extension attacks computationally infeasible without knowing the key
3. The `###{keyIndex}` suffix in the output further binds the hash to a specific key version

The practical takeaway: PhonePe's signing mechanism is secure enough for its threat model (payment API authentication), even if HMAC would be theoretically stronger. Podeum implements it exactly as specified — `sha256(value + api + key)` — because deviating from the spec, even for a "better" algorithm, would break the integration.

### 3.5 Key Management

The merchant key (`phonePeConfig.getKey()`) and key index (`phonePeConfig.getKeyIndex()`) are loaded from Dropwizard's YAML configuration:

```java
public class PhonePeConfig {
    @JsonProperty("endpoint")    private String endpoint;     // "https://api.phonepe.com/apis/hermes"
    @JsonProperty("payApi")      private String payApi;       // "/v3/merchant/init"
    @JsonProperty("statusApi")   private String statusApi;    // "/v3/merchant/status/{merchantId}/{merchantTransactionId}"
    @JsonProperty("merchantId")  private String merchantId;   // "PODEUMONLINE"
    @JsonProperty("key")         private String key;          // Secret — never logged
    @JsonProperty("keyIndex")    private int keyIndex;        // 1 (for key rotation support)
}
```

The `key` field is stored in an environment-specific YAML file (`config/production.yml`) that is **never committed to Git**. It's injected at deploy time via Kubernetes secrets or CI/CD environment variables. The configuration follows Dropwizard's standard `@JsonProperty` deserialization — no custom secret manager integration at this stage.

For a team of 2 engineers, this is acceptable. For a larger team, you'd want a secrets manager (AWS Secrets Manager, HashiCorp Vault) to avoid plaintext keys in config files. But at Podeum's scale, the operational simplicity of YAML-based config outweighed the security benefit of a dedicated secrets service — the config file is protected by filesystem permissions and Kubernetes secret volumes.

---

## 4. The Async Payment Flow: init → UPI App → Webhook → checkStatus

UPI payments are inherently asynchronous. Unlike credit card payments where the authorization happens synchronously (you submit card details, the gateway responds "approved" or "declined" in the same HTTP request), UPI involves the user switching to a different app, authenticating with their UPI PIN, and returning. This creates a fundamentally different integration pattern.

### 4.1 The Complete Flow

```
 User taps "Buy 100 Coins" in Flutter app
                │
                ▼
┌───────────────────────────────────────┐
│  POST /api/payment/init               │
│  Body: { amount: 99, package: "100c" } │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  PaymentResource → EconomyService     │
│  1. Create Transaction entity (PENDING)│
│  2. Call payment.init(payRequest)      │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  UpiPayment.init()                    │
│  1. Map to PhonePeUpiRequest          │
│  2. Base64-encode + SHA256-sign       │
│  3. POST to PhonePe /v3/merchant/init │
│  4. Return deep-link URL              │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  Flutter client receives deep-link     │
│  Opens PhonePe app (Android Intent /   │
│  iOS Universal Link)                   │
└───────────────┬───────────────────────┘
                │
                ▼
   ┌───────────────────────────┐
   │  User authenticates in     │
   │  PhonePe, enters UPI PIN,  │
   │  completes payment          │
   └───────────────┬───────────┘
                   │
        ┌──────────┴──────────┐
        │                      │
        ▼                      ▼
┌───────────────┐    ┌───────────────────────┐
│ PhonePe sends │    │ Flutter client polls   │
│ webhook to    │    │ GET /api/payment/status│
│ Podeum        │    │ every 5 seconds        │
└───────┬───────┘    └───────────┬───────────┘
        │                        │
        ▼                        ▼
┌───────────────────────────────────────────┐
│  Webhook handler:                         │
│  1. Verify isAuthorized(header, token)     │
│  2. Call payment.checkStatus(requestId)    │
│  3. Update Transaction: PENDING→SUCCESS    │
│  4. Credit coins to user wallet            │
│  5. Push notification: "Payment confirmed" │
└───────────────────────────────────────────┘
```

### 4.2 Why Two Confirmation Paths (Webhook + Polling)?

PhonePe sends a server-to-server webhook when a payment completes, and Podeum's Flutter client also polls the status endpoint every 5 seconds. This is redundancy by design — either path can confirm the payment.

**Scenario 1: Webhook arrives first (happy path)**

PhonePe's webhook hits Podeum within 2-5 seconds of the user completing the UPI PIN entry. The webhook handler calls `checkStatus()`, confirms the payment, credits the coins, and the next client poll returns `SUCCESS`. The user sees their coins appear almost instantly — no perceptible delay.

**Scenario 2: Webhook is delayed or lost (degraded path)**

Network issues, load balancer timeouts, or PhonePe's webhook delivery queue can delay the webhook by 10-30 seconds. Without client polling, the user would stare at a "Processing..." screen for half a minute, wonder if their money was lost, and likely initiate a duplicate payment (creating a support nightmare). With polling, the client discovers the payment succeeded on the next poll cycle (at most 5 seconds of delay) and transitions to the success screen — even if the webhook hasn't arrived yet.

**Scenario 3: Client loses connectivity mid-payment (offline recovery)**

The user initiates payment, switches to PhonePe, completes the UPI PIN entry, but their internet drops before the Flutter app can resume polling. The webhook still fires. When the user reopens the app (hours later, possibly on a different network), the app queries `checkStatus()` on startup and discovers the payment succeeded. The coins are credited retroactively.

**Scenario 4: Webhook arrives, but client polls before coin credit (race condition)**

The webhook handler calls `checkStatus()`, gets `SUCCESS`, and begins crediting coins (which involves a MySQL transaction — updating the Transaction entity status AND incrementing the wallet balance atomically inside a `@Transactional` method). If the client polls during this transaction, the `checkStatus()` call returns `SUCCESS` but the Transaction entity might still show `PENDING` (depending on transaction isolation level). The client sees the success state from PhonePe but doesn't see the coins yet — this is a brief window (~100ms) resolved on the next poll.

The dual-path design means Podeum never relies on a single delivery mechanism for payment confirmation. This is the same principle as the Resilience4j bulkhead pattern used in match event processing — redundancy at the integration boundary prevents single points of failure.

### 4.3 Webhook Authentication: isAuthorized()

PhonePe's webhook delivers a POST request to a Podeum endpoint. Anyone who knows that endpoint URL can POST to it. Without authentication, an attacker could forge a "payment succeeded" payload and get unlimited free coins.

The `isAuthorized()` method prevents this:

```java
@Override
public boolean isAuthorized(String encodedValue, String token) {
    // Recompute the expected hash from the received payload and API endpoint
    // using the same algorithm as the init/status requests.
    String expectedHash = getHash(encodedValue, phonePeConfig.getPayApi());

    // Extract just the hash part (before "###") and compare
    String receivedHash = token.contains("###")
        ? token.substring(0, token.indexOf("###"))
        : token;

    String expectedHashPart = expectedHash.contains("###")
        ? expectedHash.substring(0, expectedHash.indexOf("###"))
        : expectedHash;

    return receivedHash.equals(expectedHashPart);
}
```

The webhook handler extracts the `X-VERIFY` header from the incoming request, calls `isAuthorized(payload, xVerifyHeader)`, and only proceeds if it returns `true`. The method recomputes what the hash should be (using the same `getHash()` function with Podeum's secret merchant key) and compares it to what PhonePe sent. If they match, the request genuinely came from PhonePe — only PhonePe and Podeum know the merchant key.

**Why not just check the IP address?** Because PhonePe's webhook IPs can change (load balancer migrations, CDN changes, DDoS mitigation rerouting). IP whitelisting is a brittle secondary measure, not a primary security control. Cryptographic verification via the shared secret is the correct approach.

---

## 5. Idempotency: Why merchantTransactionId Prevents Double-Charges

The most dangerous bug in a payment system is double-charging a user. It's worse than losing a payment — the user WILL notice, they WILL contact support, and in India, they WILL file a chargeback with their bank (which carries penalties for the merchant).

Podeum prevents double-charges through **merchantTransactionId**, a unique identifier generated for every payment initiation.

### 5.1 How It Works

```java
// In EconomyService, when initiating a payment:
String merchantTransactionId = "PODEUM_" + userId + "_" + System.currentTimeMillis();

PayRequest payRequest = PayRequest.builder()
    .merchantTransactionId(merchantTransactionId)
    .amount(amount)
    .userId(userId)
    .packageId(packageId)
    .build();

// Create Transaction entity BEFORE calling PhonePe
Transaction transaction = new Transaction();
transaction.setMerchantTransactionId(merchantTransactionId);
transaction.setUserId(userId);
transaction.setAmount(amount);
transaction.setStatus(TransactionStatus.PENDING);
transactionRepository.save(transaction);

// Now call PhonePe
PayResponse response = payment.init(payRequest);
```

The `merchantTransactionId` serves three purposes:

| Purpose | How It Works |
|---------|-------------|
| **Idempotency at PhonePe** | PhonePe's API uses `merchantTransactionId` as the idempotency key. If Podeum submits the same `merchantTransactionId` twice (e.g., due to a network retry), PhonePe returns the original response instead of creating a duplicate payment. |
| **Idempotency at Podeum** | Before inserting a `Transaction` entity, the repository checks: `SELECT COUNT(*) FROM transaction WHERE merchant_transaction_id = ?`. If the transaction already exists, the flow is rejected — no second database record, no second PhonePe call. |
| **Payment reconciliation** | When the webhook arrives, it carries `merchantTransactionId`. Podeum looks up the existing Transaction entity by this ID (not by some auto-generated primary key), updates its status to SUCCESS, and credits the wallet. The entire flow is keyed on this ID. |

### 5.2 The Idempotency Guarantee

The combination of these three layers creates a strong guarantee:

1. **Network-level**: If the `init()` HTTP call to PhonePe times out but PhonePe actually processed it, Podeum's retry (with the same `merchantTransactionId`) gets back the original response — PhonePe recognizes the duplicate.
2. **Database-level**: The `merchantTransactionId` column in MySQL has a `UNIQUE` constraint. Two concurrent requests with the same ID will cause a constraint violation on the second insert, which the application catches and returns the existing transaction's status.
3. **Application-level**: The `PaymentResource` or `EconomyService` checks for an existing PENDING transaction for the same user + package combination before initiating a new one.

### 5.3 What Happens Without Idempotency

Consider this scenario without `merchantTransactionId` and UNIQUE constraint:

1. User taps "Buy 100 Coins" — network blip causes the HTTP request to timeout
2. Flutter client retries (automatic retry logic in the HTTP interceptor)
3. Backend processes two `init()` calls, creates two `Transaction` entities, sends two PhonePe deep-links
4. User opens the first deep-link, pays ₹99 — coins credited
5. User opens the second deep-link (from a notification or the retry response), pays ₹99 again — coins credited again, user charged twice

With `merchantTransactionId` idempotency, step 2's retry gets the same `merchantTransactionId`, step 3's second `init()` returns the existing deep-link (PhonePe recognizes the duplicate), and the user only sees one payment.

---

## 6. Integration with the Economy System

The payment gateway doesn't operate in isolation — it feeds into Podeum's virtual economy, which is backed by MySQL's ACID transactions.

### 6.1 The Transaction Entity

The `Transaction` entity in the `sql-database` module is the bridge between PhonePe's external payment world and Podeum's internal coin economy:

```java
@Entity
@Table(name = "transaction")
public class Transaction {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "merchant_transaction_id", unique = true, nullable = false)
    private String merchantTransactionId;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "amount", nullable = false)
    private BigDecimal amount;

    @Column(name = "coins", nullable = false)
    private Integer coins;

    @Column(name = "status", nullable = false)
    @Enumerated(EnumType.STRING)
    private TransactionStatus status;  // PENDING, SUCCESS, FAILED, REFUNDED

    @Column(name = "phonepe_transaction_id")
    private String phonePeTransactionId;  // PhonePe's reference (from webhook/status)

    @Column(name = "payment_method")
    private String paymentMethod;  // "UPI"

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at")
    private LocalDateTime updatedAt;

    @Column(name = "package_id")
    private String packageId;  // "100c", "500c", "1100c" — the coin package purchased
}
```

Key design decisions in this entity:

- **`merchantTransactionId` as UNIQUE**: Enforces idempotency at the database level (Section 5).
- **`status` as an enum**: Enforces valid state transitions. No stringly-typed status fields that could contain typos.
- **`phonePeTransactionId`**: Nullable because it's only populated after PhonePe confirms the payment (via webhook or status check). Before confirmation, only the merchant-side ID exists.
- **`coins` separate from `amount`**: The amount is in INR (₹), the coins are in Podeum's virtual currency. The mapping is package-specific (₹99 = 100 coins, ₹199 = 250 coins + 25 bonus, etc.).

### 6.2 The Atomic Credit Operation

When a payment is confirmed, the economy service performs a critical atomic operation:

```java
@Transactional  // Custom AOP annotation → BEGIN TRANSACTION
public void confirmPayment(String merchantTransactionId) {
    // Step 1: Load the transaction (with pessimistic lock)
    Transaction txn = transactionRepository.findByMerchantTransactionIdForUpdate(
        merchantTransactionId
    );

    // Step 2: Idempotency guard — if already SUCCESS, do nothing
    if (txn.getStatus() == TransactionStatus.SUCCESS) {
        return;  // Webhook and polling raced — this is the loser, exit cleanly
    }

    // Step 3: Mark transaction as SUCCESS
    txn.setStatus(TransactionStatus.SUCCESS);
    txn.setUpdatedAt(LocalDateTime.now());
    transactionRepository.save(txn);

    // Step 4: Credit coins to user wallet
    Wallet wallet = walletRepository.findByUserIdForUpdate(txn.getUserId());
    wallet.setBalance(wallet.getBalance() + txn.getCoins());
    wallet.setUpdatedAt(LocalDateTime.now());
    walletRepository.save(wallet);

    // Step 5: Insert ledger entry (double-entry accounting)
    LedgerEntry entry = new LedgerEntry();
    entry.setUserId(txn.getUserId());
    entry.setType(LedgerType.CREDIT);
    entry.setAmount(txn.getCoins());
    entry.setReference("PAYMENT:" + merchantTransactionId);
    entry.setCreatedAt(LocalDateTime.now());
    ledgerRepository.save(entry);

    // Transaction commits here → all 3 writes succeed or all 3 roll back
}
```

This method uses `@Transactional` (the custom AOP annotation from the `sql-database` module) to wrap all four operations in a single database transaction:

1. Update Transaction status → SUCCESS
2. Update Wallet balance (+coins)
3. Insert Ledger entry (audit trail)
4. Implicit commit at method exit

If any of these fail (database deadlock, constraint violation, connection loss), the entire transaction rolls back. The user is never in a state where the Transaction shows SUCCESS but the wallet wasn't credited, or the wallet was credited but no ledger entry exists.

**Pessimistic locking** (`SELECT ... FOR UPDATE`) on both the Transaction and Wallet rows prevents race conditions:
- If the webhook and the status-poll handler fire simultaneously, the second one blocks on the `FOR UPDATE` lock until the first commits. When it wakes up, it sees `status == SUCCESS` and exits cleanly.
- Two concurrent payments for the same user can't both increment the wallet balance — the `FOR UPDATE` on the Wallet row serializes the writes.

### 6.3 State Machine

The Transaction entity follows a strict state machine:

```
PENDING ──┬──▶ SUCCESS   (payment confirmed by PhonePe)
          ├──▶ FAILED    (payment declined, expired, or cancelled)
          └──▶ EXPIRED   (user never completed UPI auth within 5-minute window)
```

There is no `PENDING → PENDING` transition. There is no `SUCCESS → PENDING` rollback. Once a transaction reaches a terminal state (SUCCESS, FAILED, EXPIRED), it's immutable. The `status` enum in Java enforces this — there's no setter that allows arbitrary string values, only explicit transition methods.

---

## 7. HTTP Client Integration

The payment gateway delegates all HTTP communication to Podeum's `http-client` module (Module 9). This is a deliberate separation of concerns — `UpiPayment` focuses on payment logic (signing, mapping, flow orchestration) while the HTTP client handles connection pooling, timeouts, retries, and JSON deserialization.

### 7.1 The HttpClient Abstraction

```java
// In UpiPayment.java
@RequiredArgsConstructor(onConstructor = @_(@Inject))
public class UpiPayment implements Payment {
    private final PhonePeConfig phonePeConfig;
    private final UpiMapper upiMapper;
    private final HttpClient httpClient;  // From http-client module
    private final ObjectMapper mapper;

    // ...
}
```

The `HttpClient` interface (from `http-client` module) provides:

```java
public interface HttpClient {
    String post(String url, String body, Map<String, String> headers);
    String get(String url, Map<String, String> headers);
}
```

The implementation uses JAX-RS `Client` (Jersey) under the hood, configured with connection pooling, socket timeouts, and JSON deserialization. This abstraction means:
- `UpiPayment` never constructs HTTP connections directly
- Timeout configuration is centralized in the HTTP client module
- Retry logic (for transient network errors) is handled by the HTTP client, not duplicated in every payment method
- Testing `UpiPayment` is simpler — mock `HttpClient`, not a real HTTP connection

### 7.2 Headers Using ImmutableMap

PhonePe's API requires three headers on every request. `UpiPayment` constructs them using Guava's `ImmutableMap`:

```java
Map<String, String> headers = ImmutableMap.of(
    "X-VERIFY", hash,                            // SHA256 signature
    "Content-Type", "application/json",           // Always JSON
    "X-MERCHANT-ID", phonePeConfig.getMerchantId() // Podeum's merchant identifier
);
```

`ImmutableMap` is used instead of `new HashMap<>()` for two reasons:
1. **Thread safety**: `ImmutableMap` is inherently thread-safe (can't be modified after construction). If the headers map were accidentally passed to another thread, there's no risk of concurrent modification.
2. **Intent signaling**: Using `ImmutableMap` tells the reader "this map will never change" — the headers for a given request are fixed at construction time.

This is a small detail, but it's consistent with Podeum's engineering philosophy: use types to express intent. An `ImmutableMap` says more than a `Map<String, String>`.

---

## 8. Request/Response Mapping (UpiMapper)

The `UpiMapper` class handles the impedance mismatch between Podeum's internal payment model and PhonePe's API format. This is a common pattern in integration code — the external provider's JSON schema is never exactly what your internal domain model needs.

### 8.1 Internal vs. External Models

| Concept | Podeum Internal | PhonePe External |
|---------|----------------|------------------|
| Request DTO | `PayRequest` (userId, amount, packageId, merchantTransactionId) | `PhonPeUpiRequest` (merchantId, merchantTransactionId, merchantUserId, amount, redirectUrl, callbackUrl, mobileNumber) |
| Response DTO | `PayResponse` (success, redirectUrl, transactionId, message) | `PhonePeUpiResponse` (success, code, message, data.redirectUrl, data.merchantTransactionId) |
| Status DTO | `PayResponse` (unified with init response) | `PhonePeStatus` (success, code, message, data.state, data.merchantTransactionId, data.transactionId) |

### 8.2 Mapping Logic

```java
public class UpiMapper {
    public PhonPeUpiRequest toPhonePeRequest(PayRequest request) {
        PhonPeUpiRequest phonePeRequest = new PhonPeUpiRequest();
        phonePeRequest.setMerchantId(phonePeConfig.getMerchantId());
        phonePeRequest.setMerchantTransactionId(request.getMerchantTransactionId());
        phonePeRequest.setMerchantUserId(String.valueOf(request.getUserId()));
        phonePeRequest.setAmount(request.getAmountInPaise());  // Convert ₹ to paise
        phonePeRequest.setRedirectUrl(buildRedirectUrl(request));
        phonePeRequest.setCallbackUrl(buildCallbackUrl());
        phonePeRequest.setMobileNumber(request.getMobileNumber());
        return phonePeRequest;
    }

    public PayResponse toPayResponse(PhonePeUpiResponse response) {
        return PayResponse.builder()
            .success(response.isSuccess())
            .redirectUrl(response.getData() != null
                ? response.getData().getRedirectUrl() : null)
            .transactionId(response.getData() != null
                ? response.getData().getMerchantTransactionId() : null)
            .message(response.getMessage())
            .build();
    }

    public PayResponse toPayResponse(PhonePeStatus status, String requestId) {
        return PayResponse.builder()
            .success(status.isSuccess())
            .transactionId(requestId)
            .providerTransactionId(status.getData() != null
                ? status.getData().getTransactionId() : null)
            .state(status.getData() != null
                ? status.getData().getState() : null)  // "COMPLETED", "PENDING", "FAILED"
            .message(status.getMessage())
            .build();
    }
}
```

### 8.3 Why a Separate Mapper Class?

Three reasons this isn't done inline in `UpiPayment`:

1. **Testability**: `UpiMapper` can be unit-tested with simple input/output assertions. Testing mapping logic embedded in `UpiPayment` would require mocking PhonePe's API or the HTTP client.
2. **Single Responsibility**: `UpiPayment` handles signing, HTTP orchestration, and flow control. `UpiMapper` handles data transformation. If PhonePe changes their request format (e.g., adds a new required field), only the mapper changes — the payment logic stays untouched.
3. **Reusability**: If Podeum ever adds a second payment provider (e.g., Google Pay), the `PayRequest` and `PayResponse` DTOs are shared. Only a new mapper (e.g., `GooglePayMapper`) is needed — the `Payment` interface stays the same.

---

## 9. Configuration: PhonePeConfig

```java
public class PhonePeConfig {
    @NotNull
    @JsonProperty("endpoint")
    private String endpoint;        // "https://api.phonepe.com/apis/hermes"

    @NotNull
    @JsonProperty("payApi")
    private String payApi;          // "/v3/merchant/init"

    @NotNull
    @JsonProperty("statusApi")
    private String statusApi;       // "/v3/merchant/status/{merchantId}/{merchantTransactionId}"

    @NotNull
    @JsonProperty("merchantId")
    private String merchantId;      // "PODEUMONLINE"

    @NotNull
    @JsonProperty("key")
    private String key;             // Secret API key (never logged, never committed)

    @JsonProperty("keyIndex")
    private int keyIndex = 1;       // Key rotation index
}
```

The `statusApi` field contains `{merchantId}` and `{merchantTransactionId}` as URL template placeholders. At runtime, `UpiPayment.checkStatus()` performs string replacement:

```java
String statusPath = phonePeConfig.getStatusApi()
    .replace("{merchantId}", phonePeConfig.getMerchantId())
    .replace("{merchantTransactionId}", requestId);
```

This is a pragmatic choice over using a proper URI template library (like Spring's `UriTemplate` or JAX-RS `UriBuilder`) — two `String.replace()` calls vs. adding a dependency. For exactly two placeholders, the simplicity is justified.

### Environment-Specific Configuration

The `key` and `merchantId` values differ between environments:

```yaml
# config/development.yml
phonePe:
  endpoint: "https://api-preprod.phonepe.com/apis/pg-sandbox"
  payApi: "/v3/merchant/init"
  statusApi: "/v3/merchant/status/{merchantId}/{merchantTransactionId}"
  merchantId: "PODEUMTEST"
  key: ${PHONEPE_SANDBOX_KEY}    # Injected from env var
  keyIndex: 1

# config/production.yml
phonePe:
  endpoint: "https://api.phonepe.com/apis/hermes"
  payApi: "/v3/merchant/init"
  statusApi: "/v3/merchant/status/{merchantId}/{merchantTransactionId}"
  merchantId: "PODEUMONLINE"
  key: ${PHONEPE_PROD_KEY}       # Never in source control
  keyIndex: 1
```

The sandbox endpoint (`api-preprod.phonepe.com`) accepts test UPI IDs that don't transfer real money. Every payment flow is tested in sandbox before production deployment — this is standard fintech practice but worth noting because PhonePe's sandbox behavior differs from production in subtle ways (different timeout behavior, different webhook delivery guarantees).

---

## 10. Error Handling and Edge Cases

Payment integrations fail in ways that non-financial APIs don't. The HTTP request might succeed (200 OK) but the payment might still fail (declined by bank, insufficient funds, UPI PIN timeout). `UpiPayment` handles these cases:

### 10.1 PhonePe Response Codes

PhonePe's API returns `success: true/false` at the top level, but the real status is in the nested response codes:

| PhonePe Code | Meaning | Podeum Action |
|-------------|---------|---------------|
| `SUCCESS` | Payment completed | Update Transaction → SUCCESS, credit wallet |
| `PAYMENT_PENDING` | User hasn't completed UPI auth yet | Keep Transaction at PENDING, let polling continue |
| `PAYMENT_DECLINED` | Bank declined the transaction (insufficient funds, limit exceeded) | Update Transaction → FAILED, show error message |
| `PAYMENT_ERROR` | PhonePe internal error | Update Transaction → FAILED, log error, alert ops |
| `TIMEOUT` | User didn't complete UPI PIN entry within 5 minutes | Update Transaction → EXPIRED |
| `BAD_REQUEST` | Invalid request (bad signature, missing field) | Log the error, return 400 to client — this is a bug, not a user problem |

### 10.2 Network Failures During init()

If the HTTP call to PhonePe's `/v3/merchant/init` endpoint fails (timeout, connection refused, DNS resolution failure), `UpiPayment` throws a `PaymentException`. The calling service catches this and:

1. Does NOT create a Transaction entity (no PENDING record, no wallet deduction)
2. Returns a 503 Service Unavailable to the Flutter client
3. Logs the failure with full context (endpoint, payload hash, timestamp)

The client shows "Payment service unavailable — please try again" and the user can retry. No money has moved, no database state was created.

### 10.3 Network Failures During checkStatus()

If the status check fails, the behavior depends on context:

- **Client polling**: Return "status unknown" to the client. The client will poll again in 5 seconds. No state change on the server.
- **Webhook handler**: Log the failure and return 500 to PhonePe. PhonePe will retry the webhook (exponential backoff, up to 24 hours). The Transaction stays in PENDING until a successful status check.
- **Manual reconciliation**: If a transaction is stuck in PENDING for more than 30 minutes, a Quartz scheduled job queries PhonePe's status endpoint for all stale PENDING transactions. This is the safety net for missed webhooks and failed polling.

---

## 11. Security Considerations

### 11.1 The Merchant Key Must Never Be Logged

The `PhonePeConfig.getKey()` value is the cryptographic secret that proves Podeum's identity to PhonePe. If it leaks, an attacker can:
- Initiate real payments that debit users' bank accounts
- Forge webhook callbacks to credit arbitrary amounts of coins
- Query transaction statuses for any Podeum user

Podeum protects this key through:

1. **Never in source control**: The key is injected via environment variable or Kubernetes secret at deploy time. The Git history contains zero references to actual merchant keys.
2. **Never in logs**: `UpiPayment` uses `getHash()` to compute the signature, but it never logs the raw `key` value. Log statements include the computed hash and the key index, never the key itself.
3. **Never in error messages**: If PhonePe returns an error, the response is logged, but the request (which contains the signature derived from the key) is truncated to avoid leaking the full signed payload.
4. **Config toString() sanitized**: The `PhonePeConfig` class has a custom `toString()` that masks the key field: `"PhonePeConfig{endpoint=..., merchantId=PODEUMONLINE, key=***}"`.

### 11.2 HTTPS Everywhere

All PhonePe API calls use HTTPS (the `endpoint` config value starts with `https://`). This is non-negotiable — UPI payment data in plaintext HTTP would be a catastrophic security failure. The JAX-RS client in the `http-client` module is configured to reject non-HTTPS connections for payment endpoints.

### 11.3 HTTPS for Webhooks Too

The webhook callback URL registered with PhonePe must also be HTTPS. Podeum's load balancer (AWS ALB) terminates TLS and forwards to the EKS pod over HTTP (internal VPC traffic), but PhonePe's side of the connection is always TLS-encrypted.

---

## 12. Testing the Payment Gateway

Testing payment code is hard because the happy path requires an actual PhonePe sandbox environment, and even the sandbox has rate limits and eventual consistency delays. Podeum's testing strategy uses three layers:

### 12.1 Unit Tests (No External Dependencies)

```java
@Test
public void testInit_Success() {
    // Mock the HTTP client to return a valid PhonePe response
    when(httpClient.post(anyString(), anyString(), anyMap()))
        .thenReturn(VALID_PHONEPE_RESPONSE_JSON);

    PayResponse response = upiPayment.init(payRequest);

    assertTrue(response.isSuccess());
    assertNotNull(response.getRedirectUrl());
    verify(httpClient).post(
        contains("/v3/merchant/init"),
        anyString(),
        argThat(headers ->
            headers.containsKey("X-VERIFY") &&
            headers.containsKey("X-MERCHANT-ID")
        )
    );
}

@Test
public void testCheckStatus_SigningCorrect() {
    // Verify that the hash is computed over the correct URL path
    String expectedPath = "/v3/merchant/status/MERCHANT123/TXN456";
    // ... mock and verify
}

@Test
public void testIsAuthorized_ValidSignature() {
    String payload = "eyJyZXF1ZXN0IjoiZXhhbXBsZSJ9";  // base64-encoded
    String expectedHash = getHash(payload, phonePeConfig.getPayApi());

    assertTrue(upiPayment.isAuthorized(payload, expectedHash));
}

@Test
public void testIsAuthorized_TamperedPayload() {
    String originalPayload = "eyJyZXF1ZXN0IjoiZXhhbXBsZSJ9";
    String attackerHash = getHash("tampered", phonePeConfig.getPayApi());

    assertFalse(upiPayment.isAuthorized(originalPayload, attackerHash));
}
```

### 12.2 Integration Tests (PhonePe Sandbox)

Integration tests run against PhonePe's sandbox environment (`api-preprod.phonepe.com`). They use a test merchant ID and test UPI IDs that simulate different outcomes:
- `success@upi` — always completes successfully
- `failure@upi` — always fails
- `timeout@upi` — simulates user not entering UPI PIN

These tests are run manually before deployments (not in CI, because they depend on PhonePe's sandbox availability and would create flaky CI builds).

### 12.3 Idempotency Tests

```java
@Test
public void testDoubleInit_SameMerchantTransactionId() {
    PayRequest request1 = buildRequest("TXN_UNIQUE_001");
    PayRequest request2 = buildRequest("TXN_UNIQUE_001");  // Same ID

    // First call creates the transaction
    transactionRepository.save(buildTransaction("TXN_UNIQUE_001", PENDING));

    // Second call should be rejected
    assertThrows(DuplicateTransactionException.class, () -> {
        economyService.initiatePayment(request2);
    });
}
```

---

## 13. Summary: What the Payment Gateway Module Teaches

1. **Interface-based design costs nothing up front and saves everything later.** The `Payment` interface with three methods is the reason Podeum can swap payment providers without touching economy or fantasy code. Write the interface first, even when you only have one implementation.

2. **SHA256 + salt signing is adequate for payment API authentication, but you must implement it exactly to spec.** Podeum's `getHash()` method is verbatim from PhonePe's documentation — no "improvements," no "better" algorithms. Payment APIs are compliance-driven; creativity is a liability.

3. **Async payments require dual confirmation paths.** Relying solely on webhooks means losing confirmations when webhooks fail. Relying solely on polling means 5-second latency on every confirmation. Both together provide fast confirmation (polling) with guaranteed delivery (webhook retries).

4. **Idempotency is a database-level guarantee, not an application-level convention.** The `UNIQUE` constraint on `merchant_transaction_id` in MySQL is what actually prevents double-charges. Application-level checks are a best-effort convenience; the database constraint is the safety net.

5. **Pessimistic locking on wallet updates prevents race conditions.** When both the webhook and the polling handler try to credit the same wallet simultaneously, `SELECT ... FOR UPDATE` serializes them. One succeeds, the other sees the transaction is already SUCCESS and exits. No duplicate credits.

6. **The merchant key is the most sensitive secret in the entire system.** It's never in source control, never in logs, never in error messages, and masked in config toString(). If this key leaks, every coin in Podeum's economy can be stolen without a trace.

7. **UPI is the right choice for Indian fantasy gaming.** PhonePe's ~48% market share means the integration covers nearly half of all UPI users. The `Payment` interface ensures the architecture isn't locked to PhonePe forever, but shipping with one well-chosen provider was the right business decision for a 2-engineer team.

---

**Next:** [Module 6: Firebase Notifications](./06-notifications) — Push (FCM) + in-app messaging  
**Previous:** [Module 4: Redis Caching](./04-caching) — Rate limiting, sessions, ephemeral state
