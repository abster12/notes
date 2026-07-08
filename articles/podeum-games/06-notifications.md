---
title: "Module 6: Firebase Notifications — Push + In-App, Batched Writes, and Environment Isolation"
date: 2026-07-09
type: article
tags: [podeum, firebase, fcm, firestore, notifications, system-design, fantasy-gaming]
related: [podeum-games, 03-api-resources, 04-caching, 07-runtime]
audience: [senior-engineer, system-design-interview-prep]
estimated_read_time: 25 min deep read, 12 min skim
---

# Module 6: Firebase Notifications — Push + In-App, Batched Writes, and Environment Isolation

The notifications module (`notifications/src/main/java/com/podeum/notifications/`) is the engine that keeps Podeum's 10K DAU user base engaged. When a fantasy match goes live, when a pod leaderboard shifts, or when a quiz round opens, this module delivers the message — through two independent channels: **push notifications via Firebase Cloud Messaging (FCM)** that appear on the user's lock screen, and **in-app notifications persisted in Firestore** that populate an inbox the user can scroll through days later.

The module is built on **Firebase Admin SDK 6.12**, which provides a unified Java client for FCM, Firestore, and Firebase Auth. This single SDK choice means Podeum's backend has one Firebase dependency that handles three distinct platform responsibilities.

---

## Module Structure

```
notifications/src/main/java/com/podeum/notifications/
├── FireBaseMsgClient.java          → Core Firebase integration (FCM + Firestore)
├── NotificationService.java        → Orchestration layer for notification sends
├── NotificationTemplates.java      → Template-based message composition
├── dtos/
│   └── NotificationSubsDTO.java    → Subscription data-transfer object
└── mappers/
    └── NotificationMapper.java     → Entity-to-DTO mapping

api/src/main/java/com/podeum/games/api/
├── resources/
│   └── NotificationResource.java   → REST endpoints for notification management
├── services/
│   ├── NotificationService.java    → Service-layer notification orchestration
│   └── FCMNotification.java        → FCM-specific notification orchestrator
└── dtos/notifications/
    ├── FCMRegisterDeviceDTO.java
    ├── NotificationDTO.java
    ├── NotificationSubscribeDTO.java
    ├── SendNotificationDTO.java
    └── UserNotificationLastReadTimeDTO.java
```

The module splits across two Maven modules: `notifications/` holds the low-level Firebase client and template logic, while `api/` holds the REST resources and service orchestration. This separation means the notification client could theoretically be reused by scheduled jobs or webhook handlers without dragging in the full Jersey dependency graph.

---

## 1. The Dual-Channel Architecture

Podeum's notification system operates on a simple premise: **push notifications drive engagement, in-app notifications build a persistent inbox**. Each channel solves a different user need.

```
┌──────────────────────────────────────────────────────────┐
│                  NOTIFICATION TRIGGER                     │
│  (Match start, pod update, quiz open, reward earned)     │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
           ┌─────────────────────────┐
           │   NotificationService   │  ← Orchestrates both channels
           │      (api module)       │
           └───────────┬─────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼                           ▼
┌─────────────────┐        ┌─────────────────────┐
│   FCM PUSH      │        │  FIRESTORE IN-APP   │
│  (FireBaseMsg   │        │  (FireBaseMsg       │
│   Client.send)  │        │   Client.sendInApp) │
└────────┬────────┘        └──────────┬──────────┘
         │                            │
         ▼                            ▼
┌─────────────────┐        ┌─────────────────────┐
│  Android/iOS    │        │  Firestore Document │
│  Push Notification│      │  Collection:         │
│  (Lock screen)  │        │  "Notification" or   │
│                 │        │  "notificationDev"   │
└─────────────────┘        └──────────┬──────────┘
                                      │
                                      ▼
                           ┌─────────────────────┐
                           │  Flutter Client App  │
                           │  (reads Firestore    │
                           │   inbox in real-time)│
                           └─────────────────────┘
```

### Why Two Channels?

A push notification disappears after the user swipes it away. It's ephemeral. If a user gets 12 notifications during a cricket match but only checks their phone at the innings break, they'll only see the last one. The in-app Firestore inbox preserves every notification — structured as documents with `message`, `receiverId`, `timestamp`, and `read` status — so users can scroll through their notification history. This is the same pattern used by Instagram, Twitter, and most social apps: FCM for the alert, a database table (or in this case, Firestore collection) for the archive.

---

## 2. FireBaseMsgClient — The Core Integration

`FireBaseMsgClient.java` is the single class that holds all Firebase interactions for notifications. It's injected as a singleton via Guice and wraps the Firebase Admin SDK's `FirebaseMessaging` and `Firestore` clients. Let's go through every method.

### 2.1 `send(Message)` — Push Notification Delivery

```java
public void send(Message message) {
    if (isDryRun()) {
        log.info("Dry run: skipping push notification");
        return;
    }
    firebaseMessaging.sendAsync(message);
}
```

This method sends an FCM push notification. The signature accepts Firebase's own `com.google.firebase.messaging.Message` object, which means the caller (typically `FCMNotification.java` in the API layer) constructs the message with title, body, image URL, and optional data payload.

Key design decisions:

- **Async fire-and-forget:** Uses `sendAsync()` rather than blocking `send()`. Podeum doesn't need to know if a notification was delivered — the cost of blocking a webhook or API response to wait for FCM confirmation is too high. If FCM fails, the notification is lost, but that's an acceptable tradeoff at Podeum's scale.
- **Dry-run guard:** In non-production environments, `isDryRun()` returns `true`, and the method returns without calling Firebase at all. This prevents developers from accidentally spamming real users during local testing (see Section 6 for details).
- **No retry logic:** The method doesn't implement retry or dead-letter queuing. If you need guaranteed delivery, you'd add a Redis-backed retry queue (Podeum has Redis available — see Module 4). At the time this code was written, notification deliverability wasn't business-critical enough to justify the complexity.

### 2.2 `sendInApp(Map<String,String> message, List<String> receiverIds)` — Firestore Inbox Persistence

```java
public void sendInApp(Map<String, String> message, List<String> receiverIds) {
    String collectionName = getCollectionName();
    WriteBatch batch = firestore.batch();
    int count = 0;

    for (String receiverId : receiverIds) {
        DocumentReference docRef = firestore
            .collection(collectionName)
            .document();
        batch.set(docRef, message);
        count++;

        if (count % 500 == 0) {
            batch.commit();
            batch = firestore.batch();
        }
    }

    if (count % 500 != 0) {
        batch.commit();
    }
}
```

This is the in-app notification pipeline. For each receiver, it creates a new document in the Firestore notifications collection. The document contains the `message` map (which includes `title`, `body`, `type`, `matchId`, `podId`, etc.) and is keyed by Firestore's auto-generated document ID.

**Batch size of 500:** Firestore enforces a limit of 500 writes per batch operation. This method iterates through the receiver list, adding each write to a `WriteBatch`, and commits every 500 entries. The final partial batch (anything remaining after the last full 500) is committed separately.

Why 500? Firestore's `WriteBatch` has a hard limit of 500 operations. Exceeding it throws `INVALID_ARGUMENT: Maximum 500 writes allowed per request`. The batch-at-500 pattern is the standard approach for bulk writes to Firestore.

**Atomicity of batches:** Each `WriteBatch.commit()` is atomic — either all 500 writes in that batch succeed, or none do. This means if a commit fails (network error, quota exceeded), exactly 0–500 notifications are persisted. The method doesn't implement partial-failure recovery (retrying failed batches), which is a known gap — but at Podeum's scale with Firebase's reliability, batch failures were rare enough to defer this work.

**Document structure:** Each in-app notification document looks like:

```json
{
  "title": "Match Started!",
  "body": "RCB vs CSK is live. Create your fantasy team now.",
  "type": "MATCH_START",
  "matchId": "match_783492",
  "receiverId": "user_456",
  "timestamp": 1625833200000,
  "read": false
}
```

The Flutter client queries Firestore directly (using Firestore's real-time listeners) to populate the notification inbox. The server never needs to poll for read status — Firestore's snapshot listeners handle that on the client side.

### 2.3 `subscribe(List<String> tokens, String topic)` — FCM Topic Subscription

```java
public void subscribe(List<String> tokens, String topic) {
    List<List<String>> batches = Lists.partition(tokens, 250);
    for (List<String> batch : batches) {
        firebaseMessaging.subscribeToTopicAsync(batch, topic);
    }
}
```

FCM topics allow broadcasting a single message to thousands of devices without tracking individual tokens. Podeum uses topics for match-specific notifications (e.g., `match_783492_updates`) and pod-specific notifications (e.g., `pod_12345_messages`).

**Batch size of 250:** FCM's `subscribeToTopicAsync` accepts a list of registration tokens and subscribes them all to a topic. However, FCM has an undocumented practical limit of around 1,000 tokens per call. Podeum chose 250 as a safe batch size to stay well under that limit and reduce the blast radius of any single failed batch.

**When subscriptions happen:** When a user joins a pod or starts following a match, the API layer calls `subscribe()`. When they leave, `unsubscribe()` is called. The subscription model means the notification sender doesn't need to know which users are interested — it just publishes to the topic and FCM handles delivery to all subscribed devices.

### 2.4 `unsubscribe(List<String> tokens, String topic)` — FCM Topic Removal

```java
public void unsubscribe(List<String> tokens, String topic) {
    List<List<String>> batches = Lists.partition(tokens, 250);
    for (List<String> batch : batches) {
        firebaseMessaging.unsubscribeFromTopicAsync(batch, topic);
    }
}
```

The mirror of `subscribe()`. When a user leaves a pod or unfollows a match, their device token is removed from the topic. Same 250-token batch size for the same reason.

### 2.5 `getCollectionName()` — Environment-Aware Collection Naming

```java
private String getCollectionName() {
    String env = config.getEnvironment(); // "prod" or "dev"
    if ("prod".equals(env)) {
        return "Notification";
    }
    return "notification" + env.substring(0, 1).toUpperCase() + env.substring(1);
    // Returns "notificationDev" for "dev", "notificationStaging" for "staging"
}
```

This is one of Podeum's most important operational safeguards. Development and production environments share the same Firebase project (same credentials, same Firestore instance). Without environment isolation, a developer testing notifications locally would write test data into the production Firestore collection, polluting real users' inboxes.

The naming convention:
- Production: `Notification` (PascalCase, no suffix)
- Development: `notificationDev` (camelCase with PascalCase environment suffix)
- Staging (hypothetical): `notificationStaging`

The `substring(0,1).toUpperCase() + substring(1)` pattern converts the environment name to PascalCase and appends it. This ensures `dev` → `Dev`, `staging` → `Staging`, etc.

### 2.6 `isDryRun()` — Production-Only Push Delivery

```java
private boolean isDryRun() {
    return !"prod".equals(config.getEnvironment());
}
```

The simplest and most critical guard in the module. Push notifications are the one channel that has real-world consequences — they buzz users' phones. A misconfigured test sending "Test notification 123" to 5,000 real users would be a serious incident.

The dry-run mode is applied only to `send()` (push notifications). In-app Firestore writes are NOT guarded by dry-run mode, because writing test documents to the `notificationDev` collection is harmless — they won't appear in the production Flutter app which reads from the `Notification` collection.

---

## 3. NotificationService (notifications module)

The lower-level `NotificationService.java` in the `notifications/` module orchestrates notification sending. It sits between the API layer and `FireBaseMsgClient`, providing domain-level methods rather than raw Firebase calls.

```java
public class NotificationService {
    private final FireBaseMsgClient fireBaseMsgClient;
    private final NotificationTemplates templates;

    public void sendMatchNotification(Match match, List<User> users) {
        Map<String, String> message = templates.buildMatchStartMessage(match);
        List<String> userIds = users.stream().map(User::getId).collect(toList());

        // In-app persistence (all users get inbox entry)
        fireBaseMsgClient.sendInApp(message, userIds);

        // Push via FCM topic (one broadcast instead of per-user sends)
        Message fcmMessage = templates.buildFCMMessage(match);
        fireBaseMsgClient.send(fcmMessage);
    }
}
```

The key insight here: in-app notifications are delivered per-user (each user gets their own Firestore document), but push notifications are delivered per-topic (one FCM send reaches all subscribed devices). This asymmetry is intentional — it's far more efficient to broadcast to an FCM topic than to send 5,000 individual push messages.

---

## 4. NotificationTemplates — Consistent Message Formatting

`NotificationTemplates.java` ensures every notification follows a consistent structure. Instead of each service composing ad-hoc maps, templates centralize message formatting:

```java
public class NotificationTemplates {

    public Map<String, String> buildMatchStartMessage(Match match) {
        Map<String, String> message = new HashMap<>();
        message.put("type", "MATCH_START");
        message.put("title", match.getTeamA() + " vs " + match.getTeamB());
        message.put("body", "The match is live! Create your fantasy team now.");
        message.put("matchId", match.getId());
        message.put("timestamp", String.valueOf(System.currentTimeMillis()));
        return message;
    }

    public Map<String, String> buildPodInviteMessage(Pod pod, User inviter) {
        Map<String, String> message = new HashMap<>();
        message.put("type", "POD_INVITE");
        message.put("title", inviter.getName() + " invited you to " + pod.getName());
        message.put("body", "Join the pod and compete for prizes!");
        message.put("podId", pod.getId());
        message.put("timestamp", String.valueOf(System.currentTimeMillis()));
        return message;
    }

    // Additional templates: QUIZ_OPEN, REWARD_EARNED, LEAGUE_REMINDER, etc.
}
```

Templates solve two problems:
1. **Consistency:** The Flutter client parses the `type` field to render different notification UIs (match start gets a cricket ball icon, pod invite gets a group icon). If one service sends `type: "match_start"` and another sends `type: "MATCH_STARTED"`, the client's enum mapping breaks. Templates prevent this.
2. **Testability:** Templates are pure functions — input a `Match` object, output a `Map<String,String>`. They can be unit-tested without any Firebase or database dependency.

---

## 5. API Layer — REST Endpoints and Service Orchestration

The API layer exposes notification management to the Flutter client and orchestrates notification delivery from business logic.

### 5.1 NotificationResource — REST Endpoints

```java
@Path("/notifications")
@Produces(MediaType.APPLICATION_JSON)
public class NotificationResource extends AbstractResource {

    private final NotificationService notificationService;

    @POST
    @Path("/register-device")
    public Response registerDevice(FCMRegisterDeviceDTO dto) {
        notificationService.registerDevice(dto.getUserId(), dto.getFcmToken());
        return getResponse(Response.Status.OK, "Device registered");
    }

    @POST
    @Path("/subscribe")
    public Response subscribe(NotificationSubscribeDTO dto) {
        notificationService.subscribeToTopic(
            dto.getUserId(), dto.getTopic(), dto.getFcmToken()
        );
        return getResponse(Response.Status.OK, "Subscribed");
    }

    @POST
    @Path("/unsubscribe")
    public Response unsubscribe(NotificationSubscribeDTO dto) {
        notificationService.unsubscribeFromTopic(
            dto.getUserId(), dto.getTopic(), dto.getFcmToken()
        );
        return getResponse(Response.Status.OK, "Unsubscribed");
    }

    @POST
    @Path("/update-last-read")
    public Response updateLastReadTime(UserNotificationLastReadTimeDTO dto) {
        notificationService.updateLastReadTime(dto.getUserId(), dto.getTimestamp());
        return getResponse(Response.Status.OK, "Last read time updated");
    }

    @POST
    @Path("/send")  // Admin/internal endpoint
    public Response sendNotification(SendNotificationDTO dto) {
        notificationService.sendNotification(
            dto.getReceiverIds(), dto.getTitle(), dto.getBody(), dto.getType()
        );
        return getResponse(Response.Status.OK, "Notification sent");
    }
}
```

Endpoints:
- **register-device:** Called when the Flutter app starts. Stores the FCM device token mapped to the user. This token is what FCM uses to address a specific device. Tokens can change (app reinstall, Google Play Services update), so the client re-registers on every app launch.
- **subscribe / unsubscribe:** Topic management for match/pod notifications. The client calls these when the user joins/leaves a pod or starts/stops following a match.
- **update-last-read:** Tracks the user's last-read timestamp so the client can show an unread badge count. This is stored in Firestore alongside the notification documents.
- **send:** Internal/admin endpoint for sending notifications. Not exposed to end users — gated behind service-to-service auth or admin role checks.

### 5.2 NotificationService (api module)

The API-layer `NotificationService` orchestrates the full notification flow:

1. Validates receivers exist and are active
2. Resolves FCM tokens from the database for the receiver list
3. Calls `FireBaseMsgClient.send()` for push delivery
4. Calls `FireBaseMsgClient.sendInApp()` for inbox persistence
5. Logs the notification event for analytics

### 5.3 FCMNotification — FCM-Specific Orchestrator

`FCMNotification.java` handles the FCM-specific concerns:

- Constructs `com.google.firebase.messaging.Message` objects with proper Android/iOS configuration
- Sets notification priority (`high` for match starts, `normal` for general updates)
- Attaches data payloads (JSON key-value pairs) that the Flutter client uses for deep-linking — tapping a "Match Started" notification opens the match screen directly
- Manages topic-based sends (broadcast to `match_783492_updates` topic)

---

## 6. Data Flow: Match Start Notification (End-to-End)

Let's trace the complete flow when a cricket match goes live and 2,000 users need to be notified:

```
1. MatchEventService detects match status change → "LIVE"
                    │
                    ▼
2. NotificationService.sendMatchNotification(match, users)
                    │
       ┌────────────┼────────────┐
       ▼                         ▼
3a. PUSH (FCM)              3b. IN-APP (Firestore)
       │                         │
       ▼                         ▼
  FCMNotification           FireBaseMsgClient
  .sendToTopic(             .sendInApp(message,
    "match_783492_             receiverIds)  // 2,000 users
    updates",
    fcmMessage)                  │
       │                         ▼
       ▼                   WriteBatch loop:
  FireBaseMsgClient        Batch 1: users[0..499]    → commit
  .send(fcmMessage)        Batch 2: users[500..999]  → commit
       │                   Batch 3: users[1000..1499] → commit
       ▼                   Batch 4: users[1500..1999] → commit
  FCM publishes to            │
  topic; all subscribed       ▼
  devices receive push    4 batch commits, each
  within seconds           atomic (all-or-nothing)
```

Key efficiency: the push path sends **one** FCM message (topic broadcast), while the in-app path writes **2,000** Firestore documents (one per user). The asymmetry is why topic subscriptions are so important — without topics, the push path would also require 2,000 individual sends, which is slower and hits FCM rate limits.

---

## 7. Key Architectural Decisions

### Decision 1: Firebase Admin SDK 6.12 as Single Integration Layer

**What:** A single SDK (`firebase-admin`) serves three distinct needs: FCM push, Firestore documents, and Firebase Auth token verification.

**Why:** Podeum was already using Firebase Auth for phone number authentication (the only login method). Adding FCM and Firestore required adding dependency scopes to the same SDK rather than integrating new third-party libraries. The Flutter client already had Firebase initialized — zero additional client-side SDK work.

**Tradeoff:** Vendor lock-in to Google Cloud. If Podeum ever wanted to migrate off Firebase (e.g., to OneSignal for push, to a self-hosted inbox), both channels would need simultaneous migration. The team accepted this because Firebase's free tier covered Podeum's scale comfortably.

### Decision 2: Dual-Channel Notification (Push + In-App)

**What:** Every notification is delivered twice — once via FCM (ephemeral push) and once via Firestore (persistent inbox).

**Why:** Push notifications have no persistence — they vanish when dismissed. A user who receives 8 notifications during a work meeting sees only the most recent one. The Firestore inbox preserves every notification as a queryable document, enabling features like "Mark all as read," unread count badges, and notification history.

**Tradeoff:** Double the writes. A single notification to 2,000 users = 1 FCM topic publish + 2,000 Firestore writes. Firestore charges per read/write/delete, but at Podeum's scale (~50K notifications/day during IPL season), this stayed within Firebase's free tier (50K writes/day). The operational cost of maintaining a separate notification database (e.g., a MySQL table) would have exceeded the Firestore costs.

### Decision 3: Batched Writes — 500 for Firestore, 250 for FCM

**What:** Firestore writes are committed in batches of 500 (the hard limit). FCM topic subscriptions are batched in groups of 250 (well under the ~1,000 practical limit).

**Why:** Both limits are imposed by Firebase. Exceeding them throws errors. The batch sizes are defensive — 500 is exactly the Firestore limit (no headroom), while 250 for FCM subscriptions leaves ample headroom under the undocumented 1,000-token limit.

**Tradeoff with 500:** If batch 3 of 4 fails (network error during commit), users 1000–1499 get no notification but users 0–999 and 1500–1999 do. This creates inconsistent delivery within the same send operation. A more robust implementation would retry failed batches, but Podeum never observed batch failures frequently enough to justify the complexity.

### Decision 4: Environment-Aware Collection Naming

**What:** Firestore collection names change based on environment: `Notification` (prod) vs. `notificationDev` (dev).

**Why:** Dev and prod share the same Firebase project. Without collection isolation, test data contaminates production. The PascalCase convention (`Dev`, `Staging`) ensures there's zero chance of a typo causing cross-environment pollution.

**Tradeoff:** The Flutter client must be configured to read from the correct collection per build flavor. A misconfigured dev build pointed at the prod collection would show real user notifications during testing. This is a client-side concern that the backend naming convention can't solve alone.

### Decision 5: Dry-Run Mode in Non-Production

**What:** Push notifications are silently dropped in any environment except `prod`. In-app Firestore writes are NOT subject to dry-run mode.

**Why:** Push notifications buzz real phones. A developer testing locally must never accidentally send a push to actual users. In-app writes to the dev collection are harmless because the production Flutter app doesn't read from `notificationDev`.

**Tradeoff:** Developers can't test the full push notification flow locally. They can verify the Firestore write, the template formatting, and the API response — but the actual FCM delivery to a device is only testable in production. The team uses a dedicated "staging" FCM topic with test devices as a middle ground.

### Decision 6: Template-Based Notification Messages

**What:** `NotificationTemplates.java` centralizes all notification message construction as pure functions.

**Why:** The Flutter client parses the `type` field to render type-specific UI (icons, colors, deep-link targets). If different services use different strings for the same notification type, the client's enum mapping breaks silently — notifications display with wrong icons or fail to deep-link. Templates enforce consistency at compile time.

**Tradeoff:** Adding a new notification type requires changing the template class and the Flutter client enum simultaneously. This tight coupling is intentional — it forces developers to think about the client-side rendering before sending a new notification type.

---

## 8. FCM Topic Strategy

Podeum's topic naming convention reveals the notification domains:

| Topic Pattern | Trigger | Subscribers |
|---|---|---|
| `match_{matchId}_updates` | Match starts, innings break, match ends | Users following that match |
| `pod_{podId}_messages` | Pod invite, pod chat message, leaderboard update | Pod members |
| `game_{gameId}_reminders` | Game deadline approaching | Users who joined the game but haven't submitted |
| `quiz_{quizId}_open` | Quiz round opens | Users registered for the quiz |
| `global_announcements` | App-wide announcements, maintenance | All registered devices |

The topic model scales efficiently: a single FCM publish to `match_783492_updates` reaches all 500 users following that match, regardless of whether it's 50 users or 50,000. The FCM infrastructure handles the fan-out.

---

## 9. DTO Layer — Contract Between Client and Server

### NotificationSubscribeDTO

```java
public class NotificationSubscribeDTO {
    private String userId;
    private String topic;       // e.g., "match_783492_updates"
    private String fcmToken;    // Device's current FCM registration token
}
```

Used by both `/subscribe` and `/unsubscribe` endpoints. The client sends the current FCM token because tokens can change — Google may rotate a device's token after app updates or Play Services changes. Sending the token on every subscribe/unsubscribe call ensures the server always has the latest.

### SendNotificationDTO

```java
public class SendNotificationDTO {
    private List<String> receiverIds;  // User IDs for in-app delivery
    private String title;
    private String body;
    private String type;               // MATCH_START, POD_INVITE, etc.
    private String topic;              // Optional: FCM topic for push
    private String imageUrl;           // Optional: notification image
    private Map<String, String> data;  // Optional: deep-link payload
}
```

The admin send endpoint. The `topic` field is optional — if provided, push goes via topic broadcast; if omitted, push goes to individual tokens resolved from `receiverIds`.

### FCMRegisterDeviceDTO

```java
public class FCMRegisterDeviceDTO {
    private String userId;
    private String fcmToken;
    private String devicePlatform;  // "android" or "ios"
}
```

Device registration. The `devicePlatform` field enables platform-specific notification configuration (Android channel IDs, iOS APNs priorities) in `FCMNotification.java`.

### UserNotificationLastReadTimeDTO

```java
public class UserNotificationLastReadTimeDTO {
    private String userId;
    private Long timestamp;  // Unix epoch millis
}
```

Tracks when the user last viewed their notification inbox. The Flutter client uses this to calculate the unread count: `COUNT(notifications WHERE timestamp > lastReadTime AND receiverId = userId)`.

---

## 10. Failure Modes and Resilience

### Firestore Batch Commit Failure

If a `WriteBatch.commit()` fails (network timeout, Firebase quota exceeded), that batch's 500 writes are lost. The method does not retry. Mitigations:
- **Idempotency via Firestore document IDs:** Each notification gets a unique auto-generated document ID. If the caller retries the entire `sendInApp()` call, the retry creates new documents (duplicates) rather than overwriting. This is intentional — duplicate notifications are less harmful than lost notifications.
- **Firebase SLA:** Firestore has a 99.999% availability SLA. Batch commit failures are rare enough that Podeum hasn't needed retry logic.

### FCM Token Staleness

FCM tokens expire or become invalid when:
- User uninstalls the app
- Google Play Services updates
- User switches to a different device

When FCM returns a `NOT_REGISTERED` error for a token, the notification is silently dropped. Podeum doesn't implement token cleanup — over time, dead tokens accumulate in the database. A production improvement would be a scheduled job that validates tokens against FCM's batch endpoint and removes invalid ones.

### Rate Limiting

FCM enforces rate limits per project (approximately 600,000 messages/minute at default quota). At Podeum's peak (10K DAU), this is nowhere near the limit. Firestore has a soft limit of 10,000 writes/second per database — also well above Podeum's peak load of ~100 writes/second during IPL match notifications.

---

## 11. Integration With Other Modules

### Module 3 (API Layer)
`NotificationResource` and `FCMNotification` are registered as Jersey resources and Guice singletons in the API module. The `NotificationModule` Guice configuration binds the notification service and client:

```java
public class NotificationModule extends AbstractModule {
    @Override
    protected void configure() {
        bind(FireBaseMsgClient.class).in(Singleton.class);
        bind(NotificationService.class).in(Singleton.class);
        bind(NotificationTemplates.class).in(Singleton.class);
    }
}
```

### Module 7 (Runtime & Bootstrap)
The Firebase Admin SDK is initialized at application startup (`FirebaseApp.initializeApp()`) in the main `Application` class. The `FireBaseMsgClient` receives this initialized `FirebaseMessaging` and `Firestore` instance via constructor injection.

### Module 4 (Redis Caching)
Notification preferences (opt-out flags, quiet hours) are cached in Redis using `RBucket` with 1-hour TTL. This avoids a database lookup on every notification send for a user's preference.

---

## 12. Testing Strategy

### Unit Tests
- `NotificationTemplates` tests: verify all template methods produce maps with required keys (`type`, `title`, `body`, `timestamp`)
- `FireBaseMsgClient` tests: mock `FirebaseMessaging` and `Firestore`, verify batch partitioning logic (3 users → 1 batch, 750 users → 2 batches)
- DTO validation tests: ensure JSON deserialization handles null/missing fields correctly

### Integration Tests
- `getCollectionName()` tests: verify correct collection name for `prod`, `dev`, `staging` environments
- `isDryRun()` tests: verify push is skipped for `dev`, not skipped for `prod`
- End-to-end: spin up a Firebase emulator, send notifications via `NotificationResource`, verify documents appear in the correct Firestore collection

### Manual Testing
- Staging build of the Flutter app pointed at `notificationStaging` collection
- Test device subscribed to staging FCM topics
- Admin panel sends test notification — verify both push (lock screen) and in-app (inbox) delivery

---

## Summary

The notification module is a study in pragmatic Firebase usage. It doesn't try to build a general-purpose notification framework — it solves Podeum's specific needs with the simplest Firebase integration that works:

- **One SDK** (Firebase Admin) for push + inbox + auth
- **Two channels** (FCM + Firestore) for ephemeral alerts + persistent history
- **Batched writes** (500 for Firestore, 250 for FCM) to respect Firebase limits
- **Environment isolation** (collection naming + dry-run) to prevent test/prod contamination
- **Topic-based broadcasting** for efficient fan-out to thousands of devices
- **Template-driven messages** for client-side rendering consistency

The module's deliberate gaps — no retry logic, no dead-token cleanup, no delivery confirmation — reflect a team that understood their scale and chose to defer complexity until the metrics demanded it. At 10K DAU, Firebase's reliability is sufficient; at 1M DAU, several of these gaps would need to be closed.

---

## Navigation

- [Module 1: SQL Database](./01-sql-database) — 60+ entities, economy, transactions
- [Module 2: MongoDB](./02-mongodb) — Document data, live match storage
- [Module 3: API Layer](./03-api-resources) — REST resources, services, webhooks
- [Module 4: Redis Caching](./04-caching) — Bucket/Map/Cache, rate limiting
- [Module 5: PhonePe Payment Gateway](./05-payment-gateway) — UPI integration
- [Module 6: Firebase Notifications](./06-notifications) — You are here
- [Module 7: Runtime & Bootstrap](./07-runtime) — App wiring, config, filters
- [Module 8: Deployment & Infrastructure](./08-deployment) — Docker, K8s, AWS
- [Module 9: HTTP Client](./09-http-client) — External API abstraction
