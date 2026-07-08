# Podeum Games Module 3: API Layer

The API layer is the central nervous system of Podeum Games. Built on **Dropwizard** (Jersey JAX-RS), it handles everything: live cricket webhooks from Sports Interactive, real-time fantasy score calculation, pod creation and management, quiz systems, prediction markets, chat, payments, wallet economy, scheduled jobs, and service-to-service auth. This module is the most complex and code-heavy part of the Podeum stack — around 40+ JAX-RS resource classes, 42+ service classes, 25+ DTO packages, and 30+ mapper classes.

---

## 1. Architecture: Resources → Services → Repositories

The API follows a strict layered architecture enforced by Dropwizard's dependency injection (Google Guice) and JAX-RS annotations.

### Resource Layer (JAX-RS Controllers)
Each resource class is annotated with `@Path` and handles HTTP routing. They are thin — they validate input, delegate to services, and wrap responses using `AbstractResource` which returns a common `ResponseFormat` envelope:

```java
// AbstractResource.java
public Response getResponse(Response.Status statusCode, Object message) {
    ResponseFormat response = new ResponseFormat(statusCode.getStatusCode(), "",
            Objects.isNull(message) ? new HashMap<>() : message);
    return Response.status(statusCode).entity(response).build();
}
```

All resources use Lombok's `@RequiredArgsConstructor(onConstructor = @_(@Inject))` for constructor injection.

### Service Layer
Services contain all business logic. They are also constructor-injected and use `@Transactional` (both JPA's and a custom annotation) for database operations. Services call repository methods, orchestrate multi-step operations, and interact with external systems (Firebase, S3, Redis, notification services).

### Repository / Database Layer
Shared across modules (in the `sql-database` module), repositories extend either plain JDBC-based `MySQLRepository` or MongoDB adapters. The API accesses them via injection.

### Key Pathways
Client → `PodResourceV1.createPod()` → `PodServiceNew.createQuizPod()` → `PodRepository`, `GameService`, `QuizPodService`, `QuestionService`  
Client → `FantasyTeamResource.create()` → `FantasyTeamService.createFantasyTeam()` → `FantasyTeamRepository`  
Webhook → `CricketFeedResource.acceptFromBulkhead()` → `WebhookEvent.accept()` → `SportzInteractiveHandler` → dispatches to `MatchEventService`, `FirebaseCricketScoreUpdateService`, etc.

---

## 2. The Live Cricket Webhook Pipeline (Deep Detail)

This is the most critical real-time data path in Podeum. Sports Interactive (SI) sends live cricket data to a single JAX-RS endpoint, and from there a cascade of processing happens.

### 2.1 Entry Point: CricketFeedResource

```java
@Path("/webhook/cricketFeed")
public class CricketFeedResource {
    private final WebhookEvent webhookEvent;

    @POST
    public Response acceptFromBulkhead(JsonNode request) {
        webhookEvent.accept(request);
        return Response.accepted().build();
    }
}
```

The `WebhookEvent` interface is bound to `SportzInteractiveHandler` via Guice in `WebhookModule`:

```java
public class WebhookModule extends AbstractModule {
    protected void configure() {
        bind(WebhookEvent.class).to(SportzInteractiveHandler.class).in(Singleton.class);
    }
}
```

### 2.2 SportzInteractiveHandler: The Router

`SportzInteractiveHandler.accept(JsonNode request)` inspects the JSON payload structure to determine what kind of data it received, then routes accordingly:

| JSON Signature | Handler | Purpose |
|---|---|---|
| `request.has("Matchdetail")` | Multiple async dispatches | Live ball-by-ball match data |
| `request.has("Commentary")` | `commentaryEventService.handle(request)` | Ball-by-ball commentary text |
| `request.has("data")` | `SICalendarService.handle(request)` | Match calendar/schedule updates |
| `request.has("squads")` | `siSquadService.handle(request)` | Team squad updates |
| `request.has("standings")` | `siStandingsService.handle(request)` | Tournament standings |
| Everything else | `s3LiveFeedService.upsertOtherData(request)` | Catch-all archival |

When "Matchdetail" is present (live match data), the handler fires **four asynchronous tasks** using `CompletableFuture.runAsync()`:

1. **Firebase score update**: Calls itself via HTTP to `POST /podeum/v1/match/updateCricketFirebaseScore`
2. **Match status update**: Calls `POST /podeum/v1/match/updateMatchState`
3. **Fantasy team score handling**: Calls `POST /podeum/games/fantasyTeamScore/handle` — this triggers the full `MatchEventService` pipeline
4. **Prediction resolution**: If the match is not a Test match, calls prediction endpoints for question resolution

Each of these uses JAX-RS `Client` to make **internal HTTP calls** authenticated with RSA-signed JWT tokens (see section 9). This is a self-calling microservice pattern — the handler delegates heavy processing to dedicated REST endpoints rather than doing it in-process.

### 2.3 MatchEventService: The Heart of Live Scoring

`MatchEventService.handle(JsonNode request)` is called when fantasy score calculation is needed. Here's what it does step-by-step:

**Step 1: Archive the raw data to S3**
```java
private void upsertMatchEvent(JsonNode jsonNode) {
    matchFileService.upsertMatchFile(jsonNode);  // → S3LiveFeedService
}
```

**Step 2: Parse the JSON into MatchFile DTO**
The `MatchFile` class is a massive DTO (~466 lines) that maps SI's JSON structure:
- `MatchDetail` — status, toss, winning team, officials, awards
- `Map<String, Team>` — teams with their players
- `List<Inning>` — innings with batsmen, bowlers, fall of wickets, partnerships, power play details

**Step 3: Resolve SI IDs to Podeum's internal IDs**
```java
Map<String, Long> teamMap = siTeamMap(matchEvent);
Map<String, Long> siPlayerMap = siPlayerMap(matchEvent);
```
These methods query `ExternalSourceService` which looks up the `Source` table mapping external SI IDs to internal entity IDs for teams and players.

**Step 4: Calculate per-player, per-inning statistics**
`getPlayerStats()` iterates through all innings and processes:
- **Batting stats**: runs, fours, sixes, strike rate, balls played, duck detection, dismissal type
- **Dismissal-derived fielding stats**: catches (caught), stumpings (stumped), run-outs (with 2-fielders or direct-hit), LBW credit to bowler, bowled credit to bowler
- **Bowling stats**: wickets, dot balls, maidens, economy rate, overs bowled

All stats are accumulated per-inning for each player in a `Map<Long, Map<Integer, MatchPlayerStats>>` structure.

**Step 5: Calculate fantasy scores using rule engine**
```java
Map<Long, Rule> ruleMap = ruleServiceNew.findAll("fantasy", null, match.getId());
Map<Long, Map<Long, Map<Integer, Double>>> fantasyScoreByRule = new HashMap<>();
for (Map.Entry<Long, Rule> ruleEntry : ruleMap.entrySet()) {
    fantasyScoreByRule.put(ruleEntry.getKey(), getInningScore(playerStats, ruleEntry.getValue()));
}
```

`getInningScore()` calls `fantasyScoreService.getScore()` for each statistical event type:
- Batting: runs × run points, fours × four points, sixes × six points, duck penalty, milestone points (30, 50, 100 runs), strike rate performance bands
- Bowling: wickets × wicket points, dot balls × dot ball points, maidens × maiden points, LBW bonus, bowled bonus, bowling milestones (3, 4, 5 wickets), economy rate performance bands
- Fielding: catches, stumpings, run-outs, direct-hit run-outs

Minimum thresholds are format-aware (e.g., strike rate requires 10+ balls in T20, 20+ in ODI; economy requires 2+ overs in T20, 4+ in ODI).

**Step 6: Persist player stats**
`updatePlayerStats()` upserts `MatchPlayerStats` records in MySQL, keyed by `playerSportsId + inning`.

**Step 7: Dispatch fantasy score updates via Resilience4j Bulkhead**
```java
ThreadPoolBulkheadConfig config = ThreadPoolBulkheadConfig.custom()
    .maxThreadPoolSize(100)
    .coreThreadPoolSize(100)
    .queueCapacity(500)
    .keepAliveDuration(Duration.ofMinutes(3))
    .writableStackTraceEnabled(false)
    .build();

ThreadPoolBulkhead bulkhead = ThreadPoolBulkhead.of("default", config);
```

For each fantasy game associated with the match, it builds a `FantasyScoreUpdateRequest` and submits it through the bulkhead:
```java
Supplier<String> matchFileSupplier = () -> updateFantasyTeamScore(fantasyScoreUpdateRequest);
PredictionService.executeSupplier(bulkhead, matchFileSupplier, log);
```

The `updateFantasyTeamScore()` makes an internal HTTP call to `POST /podeum/games/fantasyTeamScore/update`.

### 2.4 FantasyScoreService: Applying Scores to Fantasy Teams

`FantasyScoreService.updateFantasyTeamScore()` receives the pre-calculated per-player per-inning scores and applies them to actual fantasy teams:

1. **Loads fantasy team selections** via `FantasyPlayerRepository.getFantasyPlayer(gameId)` — a custom result set query that joins fantasy players, teams, match players, and player sports
2. **Iterates through every fantasy player selection** and computes their score by summing inning scores with captain/vice-captain multipliers:
   - Single-captain format: `capMultiplier × (inn1 + inn2 + inn3 + inn4)`
   - Two-captain format (per-inning captains): `capMultiplier × inn1 + inn2` or `capMultiplier × inn2 + inn1`
   - Regular player: `inn1 + inn2 + inn3 + inn4`
   - Playing XI bonus: `rule.getScorePoints().get("match").getEvent().get("playing11")` points if the player is in the starting XI
   - Match winner prediction bonus: extra points for correctly predicting the winning team
3. **Multiplier games**: Special game IDs (8550, 8551, 8558, 8559 get 2× points; 8902, 8913 get 3×) — these are likely playoff/final multipliers
4. **Ranking calculation**: `updateRanking()` sorts all scores descending, assigns ranks with ties (standard competition ranking where tied scores share the same rank, next rank skips appropriately)
5. **Persists scores**: `scoreRepository.updateScore(score)` for each user

### 2.5 S3LiveFeedService: Permanent Archival

All raw SI data is archived to AWS S3 bucket `"live-feeds"` with a structured key hierarchy:
```
cricket/matchFile/{matchId}          — ball-by-ball match data
cricket/commentary/{matchId}/inning-{inning} — commentary text
cricket/calendar/{date}/{matchId}     — schedule data
cricket/squad/{seriesId}_{teamId}     — squad data
cricket/standings/{seriesId}          — tournament standings
cricket/standings/{otherId}          — catch-all unknown data
```

All uploads run asynchronously via `CompletableFuture.runAsync()`. Writes are gated by `awsConfig.getCricketLiveFeed().isWrite()` configuration flag.

The service also provides read methods: `getMatches(LocalDate date)` and `getSquad(seriesId, teamId)` which read from S3 for data that isn't stored in MySQL.

When a match finishes, `addMatchFinishFile()` writes a marker to the `"matchcompletedpodeum"` bucket.

### 2.6 FirebaseCricketScoreUpdateService: Client-Facing Live Scores

This service transforms SI data into a Firebase Firestore document that mobile/web clients read for live scorecards:

1. Reads the existing `MatchScoreCard` from Firestore
2. Updates toss details, match status, required run rate, equation, day/session info
3. For each innings, produces:
   - Scorecard (batsmen stats with dismissal info)
   - Summary (team totals)
   - Fall of wickets timeline
   - Yet-to-bat players list
   - Last wicket detail
   - Current run rate, extras breakdown (byes, leg byes, no balls, wides)
   - Current partnership
4. Computes Man of the Match with cumulative match stats
5. Builds squad player list with captain/playing indicators, team affiliation, skill type, images
6. Writes the complete `MatchScoreCard` to `firestore.collection("cricket{suffix}").document(matchId)`

### 2.7 MatchStatusService: Match Lifecycle

Not shown in full but referenced — manages state transitions: upcoming → live → finished. The `SportzInteractiveHandler` maps SI status values to Podeum's internal states using `MatchConfig`:

```java
List<MatchConfig.MatchStatus> matchStatuses = matchConfig.getMatchStatus();
for (MatchConfig.MatchStatus matchStatus : matchStatuses) {
    if (matchStatus.getSiValue().equalsIgnoreCase(matchFile.getMatchDetail().getStatus())) {
        currentMatchStatus = matchStatus.getValue();
    }
}
```

### 2.8 Commentary, Calendar, Squads, Standings

| Service | Purpose |
|---|---|
| `CommentaryEventService` | Processes ball-by-ball commentary, extracts summaries with bowler stats, updates match variables for prediction questions |
| `SICalendarService` | Processes match schedule data — creates/updates matches, teams, series in the database |
| `SISquadService` | Processes squad announcements — updates player lists per team |
| `SiStandingsService` | Processes tournament standings data |

Each archives its raw data to S3 and processes it into MySQL.

---

## 3. Fantasy Scoring Rules Engine

### 3.1 Rule Data Structure

Rules are stored in the database (fetched by `RuleServiceNew`) and contain:

- **`scorePoints`**: A nested map `category → event → points` and `category → milestones → points` and `category → performance → {"from-to": points}`
  - Categories: `"bat"`, `"bowl"`, `"field"`, `"match"`
  - Events: `"run"`, `"four"`, `"six"`, `"duck"`, `"wicket"`, `"dotBall"`, `"maidenOver"`, `"catch"`, `"stumping"`, `"runOut"`, `"DirectHitRunOut"`, `"lbw"`, `"bowled"`, `"matchWinner"`, `"playing11"`
  - Milestones: Batting milestones like {"30": 4, "50": 8, "100": 16} and bowling milestones like {"3": 4, "4": 8, "5": 16}
  - Performance bands: Strike rate bands like {"0-50": -6, "50-100": -2, "150-200": 2, "200-999": 6} and economy bands like {"0-4": 6, "4-6": 2, "10-12": -2, "12-999": -6}
- **`roleMultiplier`**: Captain multiplier (e.g., 2.0×), Vice-Captain multiplier (e.g., 1.5×)
- **`teamFormat.captains`**: 1 (single captain for whole match) or 2 (separate captains per innings)
- **`format`**: "t20", "odi", "test", "ipl" — controls minimum qualification thresholds for strike rate and economy rate

### 3.2 Score Calculation (in FantasyScoreService.getScore)

The `getScore()` method is a large switch statement:

**Batting events:**
```
Score += rule.bat.run × runs
Score += rule.bat.four × fours
Score += rule.bat.six × sixes
Score += rule.bat.duck (if duck)
Score += milestonePoints(runs, rule.bat.milestones)  // highest reached milestone
Score += performancePoints(strikeRate, rule.bat.performance.strikeRate)  // band-based
```

**Bowling events:**
```
Score += rule.bowl.wicket × wickets
Score += rule.bowl.dotBall × dots
Score += rule.bowl.lbw × lbwCount
Score += rule.bowl.bowled × bowledCount
Score += rule.bowl.maidenOver × maidens
Score += milestonePoints(wickets, rule.bowl.milestones)
Score += performancePoints(economy, rule.bowl.performance.economy)
```

**Fielding events:**
```
Score += rule.field.catch × catches
Score += rule.field.stumping × stumpings
Score += rule.field.runOut × runOuts
Score += rule.field.DirectHitRunOut × directHits
```

**Milestone calculation:** Finds the highest threshold reached. E.g., if a player scores 75 runs with milestones {30: 4, 50: 8, 100: 16}, they get 8 points (50 milestone, not 100).

**Performance calculation:** Iterates through band definitions like "0-50", "50-100", etc. Finds the matching band and returns its point value. If no band matches, returns the maximum configured point value.

**Minimum thresholds:**
- Strike rate only counts if player faced enough balls: 10 balls (T20/IPL), 20 balls (ODI), 10 balls (other)
- Economy rate only counts if player bowled enough overs: 2 overs (T20/IPL), 4 overs (ODI), 1 over (other)

### 3.3 MVEL Expression Engine for Prediction Rules

The `Mvel` utility class is a thin wrapper around the MVEL expression language library (org.mvel2):

```java
public static <T> T eval(String expression, Map<String, Object> matchVariables) {
    Map<String, Object> variables = new HashMap<>();
    for (String var : getVariables(expression)) {
        Object value = matchVariables.get(var);
        if (value == null) continue;
        variables.put(getExpression(var), value);  // strips '#' prefix
    }
    return (T) MVEL.eval(getExpression(expression), variables);
}
```

Variables use the `#` prefix convention (e.g., `#team_1_runs`, `#player_12345_runs`). The engine:
1. Parses the expression string to find all `#`-prefixed variable references
2. Looks up each variable in the match variables map
3. Substitutes values and evaluates with MVEL

This is used heavily in prediction question resolution — each prediction question has an expression (e.g., `#team_1_runs > #team_2_runs`) and each option has an expression — both are evaluated against live match data.

---

## 4. Pod System (Podeum Clubs)

### 4.1 Concept

Pods are user-created groups centered around cricket matches. A pod contains:
- **Games**: fantasy, prediction, quiz, or mystery player games
- **Members** (PodUsers): users who join (free or paid)
- **Chat**: Firestore-backed real-time chat
- **Leaderboards**: competitive rankings
- **Rewards**: configurable prize distributions

### 4.2 Pod Resource (PodResourceV1)

```java
@Path("v1/pods")
public class PodResourceV1 {
    @POST        → createPod(PodRequest)       // Create a new pod with games
    @POST /join  → joinPod(PodUserDTO)          // Join a pod
    @POST /exit  → exit(PodUserDTO)             // Leave a pod
    @PUT  /podStatusUpdate → updatePodStatus()   // Batch status update
    @POST /refund → refundJoin(podId)           // Refund join fees
    @GET         → discover(page, size, events, creators, games, joinCost)  // Browse pods
    @GET /filters → filters()                   // Discovery filter options
    @GET /{podId}/user/{userId} → getPodDetails()  // Full pod details
    @GET /{podId}/badges → getBadges()           // Engagement badges
}
```

### 4.3 PodServiceNew

Handles the creation orchestration. For a quiz pod:
1. Creates the Pod entity
2. Creates associated Games (one per match)
3. Creates quiz questions (fetched by tags or custom-created)
4. Sets up quiz schedule (timed rounds)
5. Notifies followers via `NotificationService`

### 4.4 Paid vs Free Pods

Pods can have a join cost (wallet coins). When users join paid pods:
- Coins are deducted from their wallet
- Winners receive rewards according to the pod's reward distribution
- `RewardsService.triggerRewards()` handles payout calculation and distribution

### 4.5 Pod Engagement

`PodEngagementService` tracks user activity metrics:
- Message count (from chat)
- Reactions received/sent
- Message deletions
- These feed into the badges/achievements system

---

## 5. Quiz System

### 5.1 Architecture

The quiz system uses **MongoDB** (via Adapter abstraction) for question storage — not MySQL.

**`QuestionService`**:
- Creates questions with shuffled options (options A/B/C/D are randomized per question instance to prevent cheating via option position)
- Supports batch upload via CSV using OpenCSV
- Tags questions for categorization and retrieval
- Questions have: question text, 4 options, correct answers (can be multiple), creator, tags

**`QuizPodService`**:
- Creates quiz pods: groups of timed questions for a specific match/category
- Manages quiz state: upcoming → live → finished
- Handles answer submission with timing validation
- Calculates scores: points for correct answers, speed bonuses for quick responses

**`QuizPlayerService`**: Tracks individual player quiz attempts and answers

**`QuizRankService`**: Computes leaderboards — ranking by total score, then by submission speed as tiebreaker

### 5.2 Quiz Workflow

1. Pod creator creates a quiz pod → questions are fetched by tags
2. Questions are published to Firebase for real-time client delivery
3. Users join the quiz pod
4. When quiz goes live, questions are revealed one at a time with countdown timers
5. Users submit answers; speed matters for tiebreaking
6. Scores are computed: correct answer + time bonus
7. Leaderboards update and rewards are distributed

---

## 6. Prediction Games

### 6.1 Concept

Prediction games let users predict match outcomes by answering questions like "Who will score more runs?" or "Will the total be over 175.5?"

### 6.2 Template System

Prediction questions are based on **templates** stored in MongoDB. A template defines:
- Question text with `#` variable placeholders (e.g., "Will #player_1_name score more than #runs?")
- Option expressions using MVEL
- The template can be reused across matches — variables are substituted with actual player names and match data

### 6.3 Variable System (PredictionVariableService)

This service maintains a massive map of match variables used by prediction expressions. Variables include:

**Team-level:**
```
#team_1_runs, #team_2_runs, #team_1_wickets, #team_2_wickets
#team_1_power_play_runs, #team_2_power_play_runs
#team_1_max_partnership, #team_2_max_partnership
#team_1_extras, #team_2_extras
```

**Player-level:**
```
#player_{id}_runs, #player_{id}_wickets, #player_{id}_boundaries_hit
#player_{id}_strike_rate, #player_{id}_economy
#player_{id}_batting_finished, #player_{id}_bowling_finished
#player_{id}_fours_hit, #player_{id}_sixes_hit
#player_{id}_dismissal, #player_{id}_batting_position
```

**Match-level:**
```
#match_winner, #match_state, #toss_winner
#total_catches, #total_fifties, #total_ducks
#max_partnership, #max_wickets
#inning_in_progress, #over_in_progress
```

**Over-level (per over of each innings):**
```
#inning_1_over_{n}_runs, #inning_1_over_{n}_bowler
#inning_2_over_{n}_runs, #inning_2_over_{n}_bowler
```

**Ranges (for slider-type questions):**
```
#runs, #wickets, #boundaries, #strike_rate, #economy, #overs, #innings
```
These generate bounded intervals (e.g., ODI runs: 0-250 in steps of 10; T20 runs: 0-150 in steps of 10).

### 6.4 Question Lifecycle

1. **Published**: Created by pod admin, visible to users, accepting answers
2. **Live**: Match is in progress, variables are being updated in real-time
3. **Delayed**: Match didn't start on time, question expiry extended
4. **Resolved**: Answer determined via MVEL evaluation
5. **Unresolved**: Could not determine answer (stays unresolved)

`PredictionService.updateQuestionState()` checks for delayed matches and marks questions as "delayed" if the match hasn't started by question expiry. Max 15 questions per prediction game.

### 6.5 Resolution

When SI sends match data:
1. `PredictionVariableService.updateMatchStats()` updates all variables from live data
2. `PredictionService.resolveQuestions()` evaluates question expressions against updated variables
3. For each question with a truthy expression, it evaluates each option's expression to find the correct answer
4. `updateLeaderBoard()` fetches all user answers, compares against resolved answers, computes scores
5. Scores are ranked (ties use standard competition ranking)
6. `PredictionPodScoreService.updateGameScores()` persists final scores

Users who submit correct predictions earn points. The system supports resolving from both MatchFile data and CommentaryData (for fine-grained ball-by-ball questions).

---

## 7. Chat System

### 7.1 Architecture

The chat system uses **Firebase Firestore** as the real-time message store (not MySQL or MongoDB). The API layer provides moderation, reaction, and management endpoints, while the actual real-time delivery is handled by Firestore's client SDK directly on mobile/web.

**ChatResource** endpoints:
```
POST /chat/message            → sendMessage(ChatMessage)      // Send a message
POST /chat/report             → report(ReportMessageDTO)      // Report a message
POST /chat/block              → blockUser(BlockPodUserDTO)    // Block a user from chat
POST /chat/reactions          → addReactions(ChatReactionDTO) // Add/remove reaction
POST /chat/delete             → deleteMessage(DeleteMessageDTO) // Delete a message
POST /chat/message/pin        → pinMessage(PinnedMessageDTO)   // Pin a message
POST /chat/message/unpin      → pinMessage(PinnedMessageDTO)   // Unpin a message
GET  /chat/message             → getMessage(podId, messageId)  // Get a specific message
GET  /chat/reactions/user/{userId}/message/{messageId} → getReactions()
```

### 7.2 Message Flow

1. Client sends `POST /chat/message` with pod ID, content, optional reply
2. `ChatService.sendMessage()`:
   - Checks spam rate limits via Redis (`CHAT_SPAM` key)
   - Validates user is a pod member with chat permission
   - Parses `@username` mentions from message content
   - Sets timestamp (server-side, epoch millis)
   - Writes message to Firestore: `messages{suffix}/{podId}/{podId}/{timestamp}`
   - Sends push notifications for mentions, replies via `NotificationService`
   - Tracks engagement metrics via `PodEngagementService`

### 7.3 Firestore Document Structure

```
Collection: messages{suffix}
  Document: {podId}
    Collection: {podId}
      Document: {timestamp}  (message ID = timestamp)
        Fields: idFrom, idTo (podId), senderName, content, timestamp,
                reply (message ID), mentions[], isVerified, pinned, reactions{}
```

### 7.4 Moderation Features

**Message Deletion**: Mods/hosts can delete messages. The deleted user gets a notification and their spam rate limit is incremented. The deleted message is archived to MongoDB via `MessageRepository`.

**User Blocking**: Hosts/moderators can block users from chat. Removes chat permission from the PodUser. Blocked users get a notification.

**Message Pinning**: Up to 3 messages can be pinned per pod (enforced by Redis rate limiter `PIN_MESSAGE`). Only hosts/moderators can pin.

**@all mentions**: Only pod creators can use @all. Rate limited via Redis to prevent spam. If rate limit exceeded, sender gets a `MENTION_EXCEEDED` warning notification.

**Spam Prevention**: `podConfig.getBlockedUsers()` blocks specific users entirely. Redis rate limiting on `CHAT_SPAM` prevents message flooding.

### 7.5 Reactions

Reactions use a toggle model — adding the same reaction again removes it. Reaction counts are maintained both in Firestore (for client reads) and MongoDB (for analytics). `ChatReactionRepository` tracks user→message→reactions mapping.

---

## 8. Quartz Job Scheduling Architecture

### 8.1 JobManager (Dropwizard Managed Lifecycle)

```java
public class JobManager implements Managed {
    private final Scheduler scheduler;

    public JobManager(QuartzConfig quartzConfig) throws SchedulerException {
        this.scheduler = new StdSchedulerFactory(quartzConfig.getProperties()).getScheduler();
    }

    public void start() {
        scheduler.clear();
        if (!quartzConfig.isEnable()) return;
        scheduler.startDelayed(quartzConfig.getDelay());
        for (QuartzConfig.Jobs job : quartzConfig.getJobs()) {
            if (!job.isEnable()) continue;
            Trigger trigger = createTrigger(job.getInterval(), job.getName());
            scheduleJob(trigger, Class.forName(job.getKlass()));
        }
    }

    public void stop() { scheduler.shutdown(); }
}
```

Jobs are configured in YAML config, loaded into `QuartzConfig`. Each job has: name, class, enable flag, interval (seconds).

### 8.2 Scheduled Jobs

| Job | Purpose | Internal Endpoint Called |
|---|---|---|
| `MatchJob` | Sync upcoming matches to Firebase | `PUT /podeum/v1/match/firebase` |
| `FantasyPlayerSelectedByJob` | Calculate fantasy player selection percentages | `PUT /podeum/game/fantasy/selection` |
| `GameRewardsJob` | Trigger reward distributions for finished games | (RewardsService) |
| `GameUserCountJob` | Update game participant counts | `PUT /podeum/games/userCount` |
| `LastPlayedJob` | Update user last-played timestamps | Internal service call |
| `PaymentJob` | Check/finalize pending payment transactions | (PaymentService) |
| `PodStatusJob` | Update pod lifecycle states (upcoming→live→ended) | `PUT /podeum/v1/pods/podStatusUpdate` |
| `PodUserCountJob` | Update pod member counts | Internal service call |
| `SeriesStatusJob` | Update series/tournament states | Internal service call |

### 8.3 Managed Lifecycle Services

Beyond Quartz jobs, several `Managed` services run at startup:

- **`LiveAndUpcomingMatches`**: Pre-loads live and upcoming match data into caches
- **`PredictionPodScore`**: Initializes prediction score calculations
- **`QuizPodScore`**: Initializes quiz score calculations
- **`SelectionByPercent`**: Caches fantasy player selection percentages

---

## 9. Service-to-Service Auth via RSA Tokens

### 9.1 The Problem

The API makes extensive **self-referencing HTTP calls**. For example, `SportzInteractiveHandler` receives a webhook and calls `POST /podeum/games/fantasyTeamScore/handle` on the same application. These internal calls need authentication to go through the auth filter/servlet.

### 9.2 RSAService

```java
public class RSAService {
    public String getToken(String userId) {
        if (System.getProperty(Constants.TOKEN) != null)
            return System.getProperty(Constants.TOKEN);
        return "Custom " + encrypt(podConfig.getBadgeAssignerId());
    }
}
```

Token generation steps:
1. If a JVM system property `TOKEN` is set, use that directly (dev/testing)
2. Otherwise, encrypt the badge assigner user ID using RSA
3. Prefix with "Custom " to indicate custom auth scheme

The RSA encryption:
- Loads private key from PKCS8-encoded file
- Loads public key from X509-encoded file
- Encrypts: `Base64(RSA_Encrypt(salt + userId + salt))`
- Decrypts: `remove_salt(RSA_Decrypt(Base64_decode(token)))`

### 9.3 Usage Pattern

Every internal HTTP call in the API attaches the token:
```java
Client client = ClientBuilder.newClient();
Response response = client.target(url)
    .request()
    .header("Authorization", rsaService.getToken(null))
    .post(Entity.entity(request, MediaType.APPLICATION_JSON));
```

Jobs use the same pattern via `System.getProperty(Constants.TOKEN)`:
```java
Response response = client.target(getUrl()).request()
    .header("Authorization", System.getProperty(Constants.TOKEN))
    .put(Entity.entity(new HashMap(), MediaType.APPLICATION_JSON));
```

The auth filter on the receiving end validates the token by decrypting it and verifying the user has appropriate permissions or matches the known service user.

---

## 10. Resilience4j Bulkhead Pattern — Why 100 Threads?

### 10.1 The Problem

When a live cricket match is in progress, SI sends webhook updates **every few seconds**. Each update triggers:
- S3 archival
- Firestore score update
- Fantasy score recalculation for every game on that match
- Prediction variable updates
- Prediction question resolution
- Notification dispatch

Without isolation, a slow database query or external service call could block the webhook processing thread, causing backpressure and delayed score updates.

### 10.2 The Solution

Both `MatchEventService` and `PredictionService` create a `ThreadPoolBulkhead` with identical configuration:

```java
ThreadPoolBulkheadConfig config = ThreadPoolBulkheadConfig.custom()
    .maxThreadPoolSize(100)
    .coreThreadPoolSize(100)
    .queueCapacity(500)
    .keepAliveDuration(Duration.ofMinutes(3))
    .writableStackTraceEnabled(false)
    .build();
ThreadPoolBulkhead bulkhead = ThreadPoolBulkhead.of("default", config);
```

### 10.3 Why These Numbers?

**100 core/max threads**: Each match event triggers fantasy score updates for potentially dozens of games (one per pod using that match). Each game update involves database reads (fantasy teams, players, rules), computation, and database writes. With multiple concurrent live matches, 100 threads ensures parallelism without overwhelming the database connection pool.

**Queue capacity of 500**: If all 100 threads are busy, up to 500 additional tasks can queue. This handles burst traffic from SI (which can send multiple updates in quick succession during exciting moments like wickets or boundaries). If the queue fills, Resilience4j rejects — better to drop an intermediate score update than to OOM the JVM.

**3-minute keep-alive**: Threads persist between webhook calls since cricket matches have continuous activity. 3 minutes prevents thread churn during lulls (drinks breaks, innings breaks) while allowing cleanup during longer gaps.

**writeableStackTraceEnabled(false)**: Performance optimization — bulkhead rejection exceptions don't need stack traces, reducing GC pressure.

### 10.4 Execution Pattern

```java
Supplier<String> supplier = () -> updateFantasyTeamScore(request);
Supplier<CompletionStage<String>> decorated = ThreadPoolBulkhead.decorateSupplier(bulkhead, supplier);
decorated.get().whenComplete((result, throwable) -> {
    if (result != null) log.debug("Received results");
    if (throwable != null) throwable.printStackTrace();
});
```

The supplier is decorated to run within the bulkhead's thread pool. `whenComplete` handles the async result — success is logged, errors are printed (in production this would go to an error tracking system).

This pattern is used identically in `PredictionService.executeSupplier()` — a static utility method shared by both services.

---

## 11. Additional API Modules

### 11.1 Economy System

| Resource | Path | Purpose |
|---|---|---|
| `WalletResource` | `/wallet` | User wallet balance, spend split (coins vs bonus coins) |
| `LedgerResource` | `/ledger` | Transaction history (debits, credits, game entries, winnings) |
| `VoucherResource` | `/voucher` | Voucher code redemption |
| `RedeemableRewardsResource` | `/redeemableRewards` | Redeemable rewards catalog |

**Wallet types**: Users have two balances — regular coins (purchased) and bonus coins (earned through gameplay). `getSpendSplit()` calculates how much comes from each balance.

**Ledger**: Every coin movement is recorded as a ledger transaction with type (JOIN_POD, GAME_WINNING, REFERRAL, PURCHASE, REFUND, etc.), enabling full audit trail.

### 11.2 Payment System

| Endpoint | Purpose |
|---|---|
| `POST /payment/upi` | Initiate UPI payment via PhonePe |
| `GET /payment/status/{id}` | Check payment status |
| `GET /payment/transactions/user/{userId}` | Transaction history |
| `POST /payment/phonepe/status` | PhonePe webhook callback |
| `PUT /payment/checkPending` | Batch reconciliation of pending payments |

### 11.3 Fantasy Team Management

`FantasyTeamResource`:
- `POST /games/fantasyTeam` — Create a fantasy team (select 11 players from the squad)
- `GET /games/fantasyTeam/game/{id}/user/{userId}` — View team with live scores
- `PUT /games/fantasyTeam/inning2Cap` — Set 2nd innings captain (for 2-captain formats)

### 11.4 Daily Games

`DailyGamesResource`: Separate from pod-based games. Daily trivia/prediction questions that all users can answer. Answers are submitted to `DailyGameService`, which checks against the correct answer and credits coins for correct responses.

### 11.5 Mystery Player

`MysteryPlayerResource`: A Wordle-like game where users guess a mystery cricket player from clues. Each wrong guess reveals another clue. `MysteryPlayerService` manages the player database, clue reveal logic, and guess validation.

### 11.6 Leagues

`LeagueResource`, `LeagueTeamResource`, `LeaguePlayerResource`, `LeagueMatchResource`, `LeagueMatchPlayerResource`: Full REST API for managing cricket leagues — creating teams, drafting players, setting lineups, viewing match results.

### 11.7 Notifications

`FCMNotification` service sends push notifications via Firebase Cloud Messaging. Template types include: `POD_CREATED`, `CHAT_MENTION`, `CHAT_REPLY`, `CHAT_REACTION`, `CHAT_DELETE`, `CHAT_RESTRICT`, `PUBLISH_QUESTION`, `ALL_MENTION`, `MENTION_EXCEEDED`. Notifications use `NotificationTemplateRepository` and `NotificationEventRepository` for configurable templates.

### 11.8 Redis Caching

`RedisResource` provides caching endpoints. Used for:
- Rate limiting (chat spam, all-mentions, pin messages, notification frequency)
- Temporary data storage (notification dedup, game reward dedup)
- Via `RedisClient.hasReachedRateLimit()` and `incrRateLimit()`

---

## 12. Module & Configuration Organization

### Guice Modules
| Module | Purpose |
|---|---|
| `WebhookModule` | Binds `WebhookEvent` → `SportzInteractiveHandler` |
| `FireBaseModule` | Provides `FirebaseApp` singleton |
| `MappingModule` | Configures mapper bindings |
| `TransactionModule` | Transaction management bindings |

### Config Classes
| Config | Purpose |
|---|---|
| `AwsConfig` | S3 bucket config, live feed enable/disable, key prefixes |
| `FireBaseConfig` | Firebase project config, RSA key paths, collection suffixes |
| `JobConfig` | Quartz job definitions (name, class, interval, enable, prefix) |
| `MatchConfig` | SI status mappings, match-related settings |
| `NotificationConfig` | FCM credentials, template settings |
| `PodConfig` | Pod creation limits, badge assigner ID, blocked users, podeum club user |
| `QuartzConfig` | Scheduler properties, global enable/disable, startup delay |
| `LeagueMatchConfig` | League-specific settings |
| `UserNameConfig` | Username generation rules |
| `VgConfig` | Voucher generation config |

---

## 13. DTO Architecture

DTOs are organized into several sub-packages under `com.podeum.games.api.dtos`:

- **`requests/`**: Incoming request bodies — `fantasy/FantasyScoreUpdateRequest`, `pods/PodRequest`, `games/GameCreateRequest`, `economy/UpdateWalletRequest`
- **`responses/`**: Outgoing response bodies — `pods/PodResponse`, `games/GameResponse`, `economy/WalletResponse`
- **`si/`**: Sports Interactive data structures — `MatchFile` (466 lines of nested inner classes for teams, innings, batsmen, bowlers, partnerships, power plays, fall of wickets), `CommentaryData`, `Calendar`, `SiSquad`
- **`fantasy/`**: Fantasy game DTOs — `FantasyTeamDTO`, `FantasyPodDTO`, `FantasyGameView`
- **`quiz/`**: Quiz DTOs — `QuizPodDTO`, `QuestionDTO`, `QuizResponseDTO`, `QuestionCSVReader`
- **`predictions/`**: Prediction DTOs — `PublishPredictionQuestion`, `PredictionPodDTO`, `PredictionAnswers`, `PredictionSubmit`
- **`chat/`**: Chat DTOs — `ChatMessage`, `ChatReactionDTO`, `DeleteMessageDTO`, `BlockPodUserDTO`, `PinnedMessageDTO`, `ReportMessageDTO`
- **`pod/`**: Pod DTOs — `PodUserDTO`, `PodUserCount`, `CreatePodData`
- **`game/`**: Game DTOs — `GameUserDTO`, `DailyGameQuestionFirebase`
- **`match/`**: Match DTOs — `MatchScoreCard` (Firebase scorecard structure with innings, batsmen, bowlers, fall of wickets), `FirebaseSquadPlayer`
- **`notifications/`**: `NotificationSubscribeDTO`

### Mappers

30+ mapper classes in `com.podeum.games.api.mappers/` handle Entity ↔ DTO conversions. Key examples:
- `FantasyTeamScoreMapper` — maps fantasy scores to response views
- `PredictionQuestionMapper` — maps MongoDB prediction questions to Firebase publish format
- `PredictionVariableService` — largest mapper, builds the ~200+ variable map from match data
- `MatchMapperV1` — maps SI data to Firebase scorecard format
- `PodMapper`, `QuizMapper`, `GameMapper`, `LeagueMapper` — domain-specific mappers

### Request/Response Flow

```
HTTP Request → JSON → Jackson deserialization → Request DTO → Service
Service → Entity operations → Result → Mapper → Response DTO → Jackson serialization → JSON → HTTP Response
```

All responses are wrapped in `ResponseFormat(statusCode, message, data)` via `AbstractResource.getResponse()`.

---

## 14. Key Design Patterns & Interview Talking Points

### Self-Calling Microservice Pattern
The API calls its own endpoints internally via HTTP rather than direct method calls. This provides:
- **Isolation**: Fantasy score calculation failures don't crash the webhook handler
- **Independent scaling**: Heavy endpoints can be scaled separately
- **Auth boundary**: Every internal call passes through auth filters
- **Retry capability**: HTTP clients can implement retry logic

### Bulkhead for Fault Isolation
The Resilience4j ThreadPoolBulkhead prevents cascading failures. If fantasy score calculation is slow or the database is under load, the webhook endpoint still accepts data and archives to S3 — scores will catch up when the bulkhead drains.

### Async-First Architecture
`CompletableFuture.runAsync()` is used extensively for fire-and-forget operations (S3 archival, Firebase updates, notifications). This keeps the webhook response fast — SI gets a 202 Accepted immediately while processing continues.

### Dual Database Strategy
- **MySQL** (via JDBC repositories): Core entities — users, matches, teams, fantasy teams, scores, wallets, ledger
- **MongoDB**: Flexible-schema data — prediction questions, prediction templates, match variables, chat archives, rewards

### Configurable Scoring Rules
Fantasy scoring is not hardcoded. Each game references a `Rule` entity that defines:
- Point values for every cricket event
- Milestone thresholds and points
- Performance bands with configurable ranges
- Captain multipliers
- Format-specific thresholds

This means different pods can use different scoring rules without code changes — e.g., an "aggressive scoring" league with double points for sixes and wickets.

---

## Summary

The Podeum Games API layer handles ~40 REST resource paths across fantasy sports, prediction markets, live quizzes, mystery player games, pod management, real-time chat, wallet economy, and payment processing. The live cricket webhook pipeline processes ball-by-ball data from Sports Interactive, archives it to S3, updates Firebase for client reads, and calculates real-time fantasy scores using a configurable rules engine — all through a Resilience4j-bulkheaded async processing pipeline. The pod system ties everything together: users create pods around matches, invite friends, compete across multiple game types, and chat in real-time. Quartz jobs handle scheduled tasks like match state updates and reward distribution. Internal service calls are authenticated via RSA-signed tokens.
