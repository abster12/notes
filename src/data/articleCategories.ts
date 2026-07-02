/**
 * Article category groupings for the notes site.
 * Maps article content IDs to display categories for the collapsible list view.
 *
 * SYSTEM DESIGN categories:
 *   Foundations — Core distributed systems primitives
 *   Databases & Storage — Persistence, indexing, object/vector/search storage
 *   Caching & Performance — CDN, edge, caching strategies
 *   Messaging & Event-Driven — Queues, streaming, real-time comms
 *   Observability & DevOps — Tracing, monitoring, resilience, platform
 *   Real-World System Designs — Full end-to-end designs from FAANG
 *   AI/ML Infrastructure — LLM serving, RAG, recommender systems, ML ops
 *
 * CODING INTERVIEW categories:
 *   Algorithm Patterns — Classic DSA patterns with Java solutions
 *   Fundamentals — Complexity analysis, language internals
 *   ML Coding — PyTorch, transformer implementations
 *   Interview Strategy — Process, behavioral, project pitches
 */

export const systemDesignCategories: Record<string, string> = {
  // ── Foundations ──
  "consistent-hashing": "Foundations",
  "rate-limiter": "Foundations",
  "rate-limiting-algorithms-deep-dive": "Foundations",
  "bloom-filters-and-probabilistic-data-structures": "Foundations",
  "lead-election-and-gossip-protocol": "Foundations",
  "two-phase-commit-and-consensus-raft-paxos": "Foundations",
  "circuit-breakers-and-bulkheads": "Foundations",
  "saga-pattern-and-distributed-transactions": "Foundations",
  "event-sourcing-and-cqrs": "Foundations",
  "design-an-idempotent-api": "Foundations",

  // ── Databases & Storage ──
  "database-indexing-and-query-optimization": "Databases & Storage",
  "database-sharding-and-replication": "Databases & Storage",
  "s3-like-object-storage": "Databases & Storage",
  "vector-database-internals-hnsw-ivf-sharding": "Databases & Storage",
  "geo-distributed-databases": "Databases & Storage",
  "search-engine-elasticsearch": "Databases & Storage",
  "video-image-storage-and-streaming": "Databases & Storage",

  // ── Caching & Performance ──
  "distributed-cache-redis-memcached": "Caching & Performance",
  "cdn-and-edge-computing": "Caching & Performance",
  "netflix-cdn-and-streaming": "Caching & Performance",

  // ── Messaging & Event-Driven ──
  "message-queue-kafka-rabbitmq": "Messaging & Event-Driven",
  "data-pipeline-architecture-kafka-flink-lakehouse": "Messaging & Event-Driven",
  "chat-system-websocket-webrtc": "Messaging & Event-Driven",
  "notification-system-push-email-sms": "Messaging & Event-Driven",

  // ── Observability & DevOps ──
  "distributed-tracing": "Observability & DevOps",
  "metrics-and-monitoring-prometheus-grafana": "Observability & DevOps",
  "chaos-engineering-failure-injection-game-days": "Observability & DevOps",
  "kubernetes-scheduler-and-control-plane-internals": "Observability & DevOps",
  "service-mesh-istio-linkerd": "Observability & DevOps",
  "gitops-and-progressive-delivery": "Observability & DevOps",
  "cloud-cost-optimization-at-scale": "Observability & DevOps",
  "privacy-and-compliance-systems": "Observability & DevOps",
  "multi-region-active-active-geo-replication-conflict-resolution": "Observability & DevOps",
  "multi-agent-orchestration-planning-tool-use-memory-routing": "Observability & DevOps",

  // ── Real-World System Designs ──
  "url-shortener": "Real-World System Designs",
  "twitter-feed-system-fan-out": "Real-World System Designs",
  "whatsapp-architecture": "Real-World System Designs",
  "uber-dispatch-system": "Real-World System Designs",
  "google-search-architecture": "Real-World System Designs",
  "payment-system": "Real-World System Designs",
  "collaborative-editor-crdts-operation-transform": "Real-World System Designs",
  "authentication-system-oauth-jwt-sso": "Real-World System Designs",
  "rate-limiter-lld-focus": "Real-World System Designs",

  // ── AI/ML Infrastructure ──
  "rag-pipeline-chunking-embeddings-retrieval-reranking": "AI/ML Infrastructure",
  "llm-serving-at-scale-vllm-quantization-batching-kv-cache": "AI/ML Infrastructure",
  "fine-tuning-infrastructure-lora-qlora-distributed-training": "AI/ML Infrastructure",
  "recommender-systems-two-tower-candidate-gen-ranking": "AI/ML Infrastructure",
  "real-time-ml-inference-streaming-features-online-learning": "AI/ML Infrastructure",
  "feature-store-and-online-offline-consistency": "AI/ML Infrastructure",
};

export const codingInterviewCategories: Record<string, string> = {
  // ── Algorithm Patterns ──
  "arrays-and-strings": "Algorithm Patterns",
  "backtracking": "Algorithm Patterns",
  "binary-search": "Algorithm Patterns",
  "bit-manipulation": "Algorithm Patterns",
  "dynamic-programming": "Algorithm Patterns",
  "graphs": "Algorithm Patterns",
  "greedy": "Algorithm Patterns",
  "hash-tables": "Algorithm Patterns",
  "heaps-and-priority-queues": "Algorithm Patterns",
  "intervals": "Algorithm Patterns",
  "linked-lists": "Algorithm Patterns",
  "sliding-window": "Algorithm Patterns",
  "sorting": "Algorithm Patterns",
  "stacks-and-queues": "Algorithm Patterns",
  "trees": "Algorithm Patterns",
  "trie": "Algorithm Patterns",

  // ── Fundamentals ──
  "big-o-and-pattern-recognition": "Fundamentals",
  "python-internals": "Fundamentals",

  // ── ML Coding ──
  "ml-coding-pytorch-foundations": "ML Coding",
  "ml-coding-transformer": "ML Coding",
  "ml-glossary": "ML Coding",

  // ── Interview Strategy ──
  "interview-process-and-strategy": "Interview Strategy",
  "project-qanda-and-behavioral-stories": "Interview Strategy",
  "design-problems": "Interview Strategy",
};
