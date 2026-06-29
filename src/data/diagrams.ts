// Diagram registry — Mermaid diagrams for flagship articles
// In a follow-up phase, this will be expanded to cover all 49 SD articles.

export interface MermaidDiagram {
  type: 'mermaid';
  title: string;
  code: string;
  asciiFallback?: string;
}

export type Diagram = MermaidDiagram;

export const diagrams: Record<string, Diagram> = {
  'url-shortener-arch': {
    type: 'mermaid',
    title: 'URL Shortener Architecture',
    code: `graph LR
      Client[Client] -->|POST /shorten| API[API Server]
      Client -->|GET /abc123| CDN[CDN Edge]
      CDN -->|cache miss| API
      API -->|read| Cache[(Redis)]
      API -->|read/write| DB[(Database)]
      API -->|analytics| Queue[Kafka]
      Queue --> Workers[Analytics Workers]
      Workers --> DW[(Data Warehouse)]`,
    asciiFallback: `Client --> API Server <--> Cache (Redis)
                     API <--> Database
                     API --> Kafka --> Workers --> Data Warehouse
                     Client <--> CDN Edge <--> API`,
  },

  'kafka-flow': {
    type: 'mermaid',
    title: 'Kafka Message Flow',
    code: `graph LR
      Producer[Producer] --> Topic[Topic: 3 Partitions]
      Topic --> P0[Partition 0]
      Topic --> P1[Partition 1]
      Topic --> P2[Partition 2]
      P0 --> C1[Consumer 1]
      P1 --> C1
      P2 --> C2[Consumer 2]
      C1 -.->|commit offset| ZK[(__consumer_offsets)]
      C2 -.->|commit offset| ZK`,
    asciiFallback: `Producer --> Topic[3 partitions]
                    P0 --> Consumer 1
                    P1 --> Consumer 1
                    P2 --> Consumer 2
                    Consumers commit offsets to __consumer_offsets`,
  },

  'rate-limiter-decision': {
    type: 'mermaid',
    title: 'Rate Limiter Decision Flow',
    code: `flowchart TD
      Start[Request arrives] --> Check{Check counter}
      Check -->|Under limit| Allow[Allow + Increment]
      Check -->|Over limit| Reject[429 Too Many Requests]
      Allow --> End[Forward to service]
      Reject --> End2[Return error to client]`,
    asciiFallback: `Request --> Check counter
                    Under limit --> Allow + increment
                    Over limit --> 429 Too Many Requests`,
  },

  'consistent-hashing-ring': {
    type: 'mermaid',
    title: 'Consistent Hashing Ring',
    code: `graph LR
      K1(Key K1) --> H1(hash mod 2^32)
      H1 --> Ring((Ring))
      Ring --> N1[Node A]
      Ring --> N2[Node B]
      Ring --> N3[Node C]
      Ring --> N4[Node D]
      K1 -.->|clockwise from hash| N1`,
    asciiFallback: `Key K1 --> hash(K1) mod 2^32 --> position on ring
                    Walk clockwise to first node
                    That node owns the key`,
  },

  'database-sharding': {
    type: 'mermaid',
    title: 'Database Sharding',
    code: `graph TD
      App[Application] --> Router{Shard Router}
      Router -->|user_id % 4 = 0| S0[(Shard 0)]
      Router -->|user_id % 4 = 1| S1[(Shard 1)]
      Router -->|user_id % 4 = 2| S2[(Shard 2)]
      Router -->|user_id % 4 = 3| S3[(Shard 3)]
      S0 --> R0[(Replica 0)]
      S1 --> R1[(Replica 1)]
      S2 --> R2[(Replica 2)]
      S3 --> R3[(Replica 3)]`,
    asciiFallback: `Application --> Shard Router
                     Router --> Shard 0 (users 0,4,8...) + Replica
                     Router --> Shard 1 (users 1,5,9...) + Replica
                     Router --> Shard 2 (users 2,6,10...) + Replica
                     Router --> Shard 3 (users 3,7,11...) + Replica`,
  },

  'cdn-edge': {
    type: 'mermaid',
    title: 'CDN Request Flow',
    code: `sequenceDiagram
      participant U as User (Tokyo)
      participant E as Edge (Tokyo)
      participant O as Origin (US-East)
      U->>E: GET /logo.png
      E->>E: Cache HIT
      E-->>U: 200 OK (5ms)
      Note over U,E: First request
      U->>E: GET /logo.png
      E->>O: Cache MISS
      O-->>E: 200 OK
      E->>E: Cache for 1 hour
      E-->>U: 200 OK (200ms)`,
    asciiFallback: `User --> Edge PoP (geo-routed)
                    HIT  → 5ms response
                    MISS → fetch from origin → cache → response`,
  },

  'load-balancing': {
    type: 'mermaid',
    title: 'Load Balancer Decision Flow',
    code: `flowchart TD
      R[Request] --> LB{Load Balancer}
      LB -->|Round Robin| S1[Server 1]
      LB -->|Round Robin| S2[Server 2]
      LB -->|Round Robin| S3[Server 3]
      LB -->|Least Connections| S1
      LB -->|Least Connections| S2
      LB -.->|Health check| HC[(Health checks)]`,
    asciiFallback: `Request --> Load Balancer
                     Algorithms: round-robin, least-conn, consistent-hash, IP-hash
                     Health checks every 5s remove dead servers`,
  },

  'cqrs-event-sourcing': {
    type: 'mermaid',
    title: 'Event Sourcing + CQRS',
    code: `graph LR
      C[Client] --> Cmd[Command]
      Cmd --> AG[Aggregate]
      AG --> ES[(Event Store)]
      ES -->|events| Proj[Projector]
      Proj --> RM[(Read Model)]
      Q[Query] --> RM
      RM -->|response| C`,
    asciiFallback: `Command --> Aggregate --> Event Store
                    Events --> Projector --> Read Model
                    Query --> Read Model --> Response`,
  },
};
