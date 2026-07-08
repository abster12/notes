# Module 8: Deployment & Infrastructure

**Package:** `com.podeum.games.deployment` (infrastructure-as-code)

**Files:**
- `deployment/deployment.yml` — Production Kubernetes Deployment manifest (git-crypt encrypted)
- `deployment/dev-deployment.yml` — Development Deployment (git-crypt encrypted)
- `deployment/deployment-2.yml` / `dev-deployment-2.yml` — Secondary replica Deployments
- `deployment/service.yml` — Kubernetes Service manifest
- `deployment/ingress.yaml` — Kubernetes Ingress configuration
- `build_script.sh` — Build-and-deploy shell script (unencrypted)
- `Dockerfile` — Multi-stage Docker build (unencrypted)
- `rds-ca-certs/` — AWS RDS CA certificate bundle for TLS connections

**Infrastructure stack:**
| Component | Technology | Details |
|-----------|-----------|---------|
| Container runtime | Docker | Multi-stage build (maven:3.8-jdk-8 → openjdk:8) |
| Container registry | AWS ECR | `301708254187.dkr.ecr.ap-south-1.amazonaws.com/podeum-backend:{version}` |
| Orchestration | Kubernetes (AWS EKS) | Deployments, Services, Ingress, Secrets |
| CI/CD | CircleCI + build_script.sh | Maven package, Docker build, ECR push, K8s deploy |
| Database | AWS RDS (MySQL 8) | TLS via rds-ca-certs bundle |
| Cache | AWS ElastiCache (Redis) | Redisson client, single-node mode |
| Storage | AWS S3 | `live-feeds` bucket for cricket data archival, `matchcompletedpodeum` bucket |
| Observability | New Relic + AWS OpenTelemetry | Commented out in Dockerfile (NR), OTEL agent downloaded at build |

---

## Dockerfile Analysis

```dockerfile
FROM maven:3.8-jdk-8-slim as build
WORKDIR /build
COPY . /build

FROM openjdk:8
WORKDIR /app
COPY --from=build /build/runtime/target/podeum-backend.jar /app/podeum-backend.jar
COPY --from=build /build/rds-ca-certs /app/rds-ca-certs

ADD https://github.com/aws-observability/aws-otel-java-instrumentation/releases/latest/download/aws-opentelemetry-agent.jar /app/aws-opentelemetry-agent.jar

CMD java $JVM_ARGS -cp /app/podeum-backend.jar com.podeum.games.runtime.GameApplication server /app/config/podeum-backend-config.yml
```

Key observations:

1. **Multi-stage build**: Maven with JDK 8 slim image for compilation, plain `openjdk:8` for runtime. The slim build image (which includes Maven and all compile-time dependencies) is discarded — only the shaded JAR and certs are copied to the final image.

2. **Shaded JAR deployment**: The entire application — all 9 modules, all dependencies — compiles into a single `podeum-backend.jar`. No external classpath, no WAR files, no Tomcat. Dropwizard's shade plugin embeds everything including the embedded Jetty server.

3. **Config injected at runtime**: The config file path is `/app/config/podeum-backend-config.yml` — this is mounted from a Kubernetes Secret, not baked into the image. Same image runs in dev and prod; only the mounted config differs.

4. **AWS OTEL agent**: Downloaded at build time from GitHub releases. Configured via environment variables (`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_ENDPOINT`) at container startup, not in the Dockerfile.

5. **JVM args via env var**: `$JVM_ARGS` allows operators to tune heap, GC, and other JVM flags without rebuilding the image. Typical values: `-Xmx2g -Xms1g -XX:+UseG1GC`.

6. **New Relic commented out**: The original Dockerfile had New Relic APM agent (newrelic.jar + `-javaagent`), later replaced with AWS OpenTelemetry. The commented-out line shows the migration path.

---

## Build & Deploy Pipeline (build_script.sh)

```bash
# Usage: ./build_script.sh -e prod -c update -v 1.2.3 -b true -n backend

# Step 1: AWS ECR authentication
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin \
  301708254187.dkr.ecr.ap-south-1.amazonaws.com

# Step 2: Maven build (shaded JAR)
mvn clean package

# Step 3: Docker build (linux/amd64 for EKS compatibility)
docker build --platform linux/amd64 \
  -t 301708254187.dkr.ecr.ap-south-1.amazonaws.com/podeum-backend:$VERSION .

# Step 4: Push to ECR
docker push 301708254187.dkr.ecr.ap-south-1.amazonaws.com/podeum-backend:$VERSION

# Step 5: Update Kubernetes Secret (config + credentials)
kubectl create secret generic podeum-backend-config \
  --from-file=runtime/config/$ENV/podeum-backend-config.yml \
  --from-file=runtime/config/serviceAccountKey.json \
  --from-file=runtime/config/public.key \
  --from-file=runtime/config/private.key \
  --from-file=runtime/config/$ENV/newrelic.yml \
  --from-file=runtime/config/$ENV/redission.yml \
  --from-file=runtime/config/$ENV/scripts_config.json \
  -n $NAMESPACE -o yaml --dry-run=client | kubectl replace -f -
```

Key design decisions:

1. **AWS region `ap-south-1` (Mumbai)**: Chosen for lowest latency to Indian users. ECR, RDS, ElastiCache, S3, and EKS all in the same region.

2. **ECR over Docker Hub**: Private container registry within AWS VPC — no data transfer costs, IAM-based auth instead of username/password.

3. **Kubernetes Secret for config**: 6 files mounted from a single Secret (`podeum-backend-config`) at `/app/config/`. This includes:
   - Dropwizard YAML config (DB URLs, Redis endpoints, PhonePe keys)
   - Firebase service account key (JSON)
   - RSA public/private key pair (for internal service-to-service auth)
   - New Relic config
   - Redisson (Redis client) config
   - Scripts config (S3 bucket names, feature flags)

4. **`--dry-run=client | kubectl replace`**: Updates the Secret in-place without deleting and recreating it. This preserves the Secret's UID and avoids a brief window where no Secret exists.

5. **Build flag separation**: `-b true` controls whether to build+push a new image. `-c update` controls whether to update the K8s config. This allows config-only changes (e.g., scaling parameters) without a full rebuild.

---

## Kubernetes Deployment Architecture

From the deployment manifests (git-crypt encrypted), the inferred structure:

```
┌────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster (AWS EKS)             │
│                                                             │
│  ┌──────────────────────┐    ┌──────────────────────┐      │
│  │   Deployment 1 (prod)│    │   Deployment 2 (prod) │     │
│  │   podeum-backend     │    │   podeum-backend-2    │     │
│  │   replicas: N        │    │   replicas: N         │     │
│  └──────────┬───────────┘    └──────────┬───────────┘      │
│             │                            │                  │
│             └──────────┬─────────────────┘                  │
│                        ▼                                    │
│              ┌──────────────────┐                          │
│              │  Service (ClusterIP)                        │
│              │  port: 8080 (app)                           │
│              │  port: 8081 (admin)                         │
│              └────────┬─────────┘                          │
│                       │                                     │
│                       ▼                                     │
│              ┌──────────────────┐                          │
│              │  Ingress (ALB)                              │
│              │  TLS termination                           │
│              │  → /podeum/games/*                         │
│              └──────────────────┘                          │
│                                                             │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  AWS RDS (MySQL) │  │ ElastiCache  │  │  AWS S3      │ │
│  │  db.t3.large     │  │ (Redis)      │  │  live-feeds  │ │
│  │  Multi-AZ        │  │ cache.t3.micro│  │              │ │
│  └──────────────────┘  └──────────────┘  └──────────────┘ │
└────────────────────────────────────────────────────────────┘
```

---

## Configuration Hierarchy

```
runtime/config/
├── local/           # Local development (macOS)
│   ├── podeum-backend-config.yml  (git-crypt encrypted)
│   ├── redission.yml
│   └── newrelic.yml
├── dev/             # Development cluster
│   ├── podeum-backend-config.yml  (git-crypt encrypted)
│   ├── redission.yml
│   └── newrelic.yml
└── prod/            # Production cluster
    ├── podeum-backend-config.yml  (git-crypt encrypted)
    ├── redission.yml
    └── newrelic.yml
```

**git-crypt encryption**: All `podeum-backend-config.yml` files (and the Kubernetes deployment manifests) are encrypted with git-crypt. This means database passwords, PhonePe API keys, Firebase private keys, and AWS credentials never appear in plaintext in the Git history. Only authorized developers with the symmetric key can decrypt them.

---

## Infrastructure Decisions

### 1. Why AWS EKS (not Elastic Beanstalk, not EC2 directly)?

**Decision:** Kubernetes on EKS.

**Why:**
- **Declarative infrastructure**: Deployment YAML is version-controlled alongside application code. Rolling updates, health checks, and resource limits are declarative.
- **Horizontal scaling**: `kubectl scale deployment podeum-backend --replicas=5` during IPL match spikes.
- **Secret management**: Kubernetes Secrets for config prevents config from being baked into Docker images.
- **Rolling updates**: Zero-downtime deploys. New pods start, pass health checks, then old pods terminate.

**Why not simpler?**
- **Elastic Beanstalk**: Would work for a simpler app, but the multi-container architecture (matching webhook timing with live sports) needed fine-grained health check and resource control that Beanstalk abstracts away.
- **EC2 directly**: Managing instances manually would be a full-time job. EKS handles node replacement, scaling, and scheduling.
- **Fargate (serverless containers)**: Cold start latency on webhook endpoints was unacceptable — live cricket data arrives in bursts and needs immediate processing.

### 2. Why ECR + ap-south-1?

**Decision:** AWS ECR in Mumbai region.

**Why:**
- Zero data transfer costs between ECR and EKS (same VPC, same region).
- IAM-based authentication — no Docker Hub credentials to rotate.
- `ap-south-1` provides ~20-40ms latency to Indian users. Cross-region would add 150ms+.
- All dependent services (RDS, ElastiCache, S3) are also in `ap-south-1` — no cross-region data transfer costs.

### 3. Why Kubernetes Secrets (not Vault, not Parameter Store)?

**Decision:** Kubernetes Secrets with `kubectl replace` for updates.

**Why:**
- No additional infrastructure (Vault requires its own cluster).
- Secrets are scoped to the namespace — `backend` namespace pods can't access `frontend` secrets.
- Mounted as files at `/app/config/` — Dropwizard reads YAML files natively, no code changes needed.

**Tradeoff:** K8s Secrets are base64-encoded, not encrypted at rest by default. For a production gaming platform handling UPI payments, this was acceptable because:
- EKS encrypts etcd at rest (AWS-managed KMS).
- RBAC limits Secret access to the `backend` namespace.
- git-crypt encrypts the Secret values in the source of truth (Git).

### 4. Why git-crypt (not SOPS, not sealed-secrets)?

**Decision:** git-crypt for encrypting config files in Git.

**Why:**
- Zero operational overhead — no key server, no KMS setup.
- Transparent to Git workflows — `git diff` works on decrypted files.
- Symmetric key shared among the 2 backend engineers.
- Config files are small (<20KB), so the performance cost of decryption is negligible.

**Tradeoff:** Key distribution is manual. Adding a third engineer means securely sharing the symmetric key. At Podeum's team size (2 backend engineers), this was not a problem.

---

## Runtime Details

### JVM Configuration

The Dockerfile uses `$JVM_ARGS` which allows per-environment tuning without rebuilding:

```bash
# Typical production JVM_ARGS:
-Xmx2g -Xms1g \
-XX:+UseG1GC \
-XX:MaxGCPauseMillis=200 \
-XX:+HeapDumpOnOutOfMemoryError \
-XX:HeapDumpPath=/app/heapdumps/ \
-Dcom.sun.management.jmxremote \
-Dcom.sun.management.jmxremote.port=9010 \
-Dcom.sun.management.jmxremote.authenticate=false \
-Dcom.sun.management.jmxremote.ssl=false
```

### Health Check

The `HealthTask` (registered as `"health check"` in `GameApplication.run()`) pings MongoDB. Kubernetes uses this for:
- **Liveness probe**: If health check fails, K8s restarts the pod. Prevents zombie processes.
- **Readiness probe**: If health check fails, K8s removes the pod from the Service load balancer. Prevents traffic from reaching a pod that can't serve requests.

### Dropwizard Admin Port

Dropwizard exposes an admin interface on port 8081 (separate from the main app on 8080). This is typically not exposed via Ingress but is available within the cluster for operational tasks (thread dumps, health checks, metrics).

---

## CI/CD Pipeline (CircleCI)

The pipeline is inferred from `build_script.sh` and the `.circleci/` directory structure:

```
Git push (main branch)
  │
  ▼
CircleCI trigger
  │
  ├─► Stage 1: Build
  │   ├── Checkout code (git-crypt unlock via CI secret)
  │   ├── mvn clean test
  │   └── mvn package (shaded JAR)
  │
  ├─► Stage 2: Docker
  │   ├── docker build (with build args: version)
  │   └── docker push to ECR
  │
  └─► Stage 3: Deploy
      ├── kubectl set image deployment/podeum-backend
      └── kubectl rollout status deployment/podeum-backend
```

---

## Scaling Characteristics

| Scenario | Scaling Action | Rationale |
|----------|---------------|-----------|
| IPL match start | Scale to 5 replicas | 10K concurrent users joining pods, checking lineups |
| Between matches | Scale to 2 replicas | Baseline traffic: leaderboards, rewards, user profile |
| Webhook storm (wicket falls) | No scale — Bulkhead absorbs | MatchEventService uses 100-thread bulkhead; adding pods mid-event would miss the burst |
| Payment spike (reward redemption) | Scale RDS read replicas | Economy ledger writes are the bottleneck, not app CPU |
| Off-season | Scale to 1 replica | Cost optimization; K8s HPA can scale to 0 if traffic drops below threshold |

---

## Security Considerations

1. **TLS everywhere**: RDS connections use `rds-ca-2019-root.pem`. ECR communication is HTTPS. Ingress terminates TLS at the ALB.
2. **PhonePe key**: The SHA256 signing key is in the Kubernetes Secret, never logged, never in application code.
3. **Firebase service account**: JSON key file mounted from Secret, never baked into the Docker image.
4. **RSA keys**: Public/private key pair generated per deployment, used for internal service-to-service JWT signing.
5. **No sensitive data in logs**: `@Slf4j` annotations throughout the codebase but the logging configuration (in Dropwizard config) excludes PII fields.

---

## What This Module Teaches (Interview-Ready)

1. **Single JAR + external config**: The image is immutable; config is injected at runtime. This is the 12-factor app pattern — build once, deploy many times.
2. **Cloud-native on AWS**: Every component (ECR, EKS, RDS, ElastiCache, S3) is a managed AWS service. No self-hosted databases, no custom container registries.
3. **Declarative infrastructure**: K8s manifests and build scripts are version-controlled. Reproducible deployments at any commit.
4. **Secret management maturity**: Three layers — git-crypt for Git, K8s Secrets for runtime, IAM for AWS access. No plaintext credentials in any layer.
5. **Cost-conscious scaling**: HPA-based replica count tuned to sports calendar. Off-season scale-down shows operational awareness.
6. **Region selection matters**: Mumbai region chosen for Indian user base. Cross-region latency would kill the live sports experience.
