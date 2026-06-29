// Hand-crafted animated SVG diagrams for flagship articles
// These use SMIL animations and CSS keyframes

export const consistentHashingRing = `<svg viewBox="0 0 500 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Consistent hashing ring">
  <defs>
    <style>
      @keyframes pulse-node {
        0%, 100% { opacity: 1; r: 8; }
        50% { opacity: 0.7; r: 10; }
      }
      .node { fill: #e85d04; animation: pulse-node 2.5s ease-in-out infinite; }
      .node-text { font: 600 11px Inter, sans-serif; fill: #1a1a2e; text-anchor: middle; }
      .ring { fill: none; stroke: #e85d04; stroke-width: 2; stroke-dasharray: 4 4; }
      .key { fill: #1a1a2e; }
      .key-text { font: 600 12px 'JetBrains Mono', monospace; fill: #1a1a2e; text-anchor: middle; }
      .arc { fill: none; stroke: #f77f00; stroke-width: 2.5; stroke-linecap: round; opacity: 0.9; }
      @keyframes arc-glow {
        0% { stroke-dashoffset: 200; }
        100% { stroke-dashoffset: 0; }
      }
      .arc-anim { stroke-dasharray: 6 6; animation: arc-glow 1.5s linear infinite; }
    </style>
  </defs>

  <text x="250" y="22" text-anchor="middle" font-family="Inter" font-size="14" font-weight="600" fill="#1a1a2e">
    Consistent Hashing Ring
  </text>

  <!-- Ring -->
  <circle cx="250" cy="170" r="110" class="ring" />

  <!-- Nodes around the ring (5 nodes, evenly distributed) -->
  <g>
    <circle cx="250" cy="60"  class="node" />
    <text   x="250" y="44"  class="node-text">Node A</text>
  </g>
  <g>
    <circle cx="356" cy="115" class="node" />
    <text   x="385" y="120" class="node-text" text-anchor="start">Node B</text>
  </g>
  <g>
    <circle cx="356" cy="225" class="node" />
    <text   x="385" y="230" class="node-text" text-anchor="start">Node C</text>
  </g>
  <g>
    <circle cx="250" cy="280" class="node" />
    <text   x="250" y="302" class="node-text">Node D</text>
  </g>
  <g>
    <circle cx="144" cy="225" class="node" />
    <text   x="115" y="230" class="node-text" text-anchor="end">Node E</text>
  </g>

  <!-- Key K1 at hash position -->
  <circle cx="144" cy="115" r="6" class="key" />
  <text   x="115" y="110" class="key-text" text-anchor="end">Key K1</text>

  <!-- Arc from key clockwise to Node B (animated) -->
  <path d="M 144 115 A 110 110 0 0 1 356 115" class="arc arc-anim" />

  <text x="250" y="170" text-anchor="middle" font-family="Inter" font-size="11" fill="#555570">
    Walk clockwise →
  </text>
</svg>`;

export const tokenBucket = `<svg viewBox="0 0 500 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Token bucket rate limiter">
  <defs>
    <style>
      @keyframes fill-up {
        0% { height: 0; y: 200; }
        100% { height: 140; y: 60; }
      }
      @keyframes drain-down {
        0%, 100% { height: 140; y: 60; }
        50% { height: 70; y: 130; }
      }
      .bucket-water {
        fill: #e85d04;
        opacity: 0.7;
        animation: drain-down 4s ease-in-out infinite;
      }
      .bucket { fill: none; stroke: #1a1a2e; stroke-width: 2.5; }
      .token { fill: #f77f00; stroke: #1a1a2e; stroke-width: 1.5; }
      .label { font: 600 12px Inter, sans-serif; fill: #1a1a2e; }
      .arrow { fill: none; stroke: #1a1a2e; stroke-width: 1.5; }
      @keyframes request-fly {
        0% { transform: translateX(0); opacity: 0; }
        20% { opacity: 1; }
        100% { transform: translateX(180px); opacity: 0; }
      }
      .request { animation: request-fly 3s linear infinite; }
      .request-2 { animation: request-fly 3s linear infinite; animation-delay: 1s; }
      .request-3 { animation: request-fly 3s linear infinite; animation-delay: 2s; }
    </style>
  </defs>

  <text x="250" y="22" text-anchor="middle" font-family="Inter" font-size="14" font-weight="600" fill="#1a1a2e">
    Token Bucket
  </text>

  <!-- Bucket (trapezoid-ish) -->
  <path d="M 80 200 L 80 60 L 220 60 L 220 200 Z" class="bucket" />
  <rect x="80" y="60" width="140" height="140" class="bucket-water" />

  <!-- Tokens -->
  <g>
    <circle cx="110" cy="90" r="6" class="token" />
    <circle cx="140" cy="85" r="6" class="token" />
    <circle cx="170" cy="92" r="6" class="token" />
    <circle cx="125" cy="110" r="6" class="token" />
    <circle cx="155" cy="115" r="6" class="token" />
    <circle cx="190" cy="110" r="6" class="token" />
  </g>

  <!-- Refill arrow (left side) -->
  <line x1="35" y1="130" x2="75" y2="130" class="arrow" marker-end="url(#arrowhead)" />
  <text x="35" y="120" class="label">+1 token / sec</text>

  <!-- Requests flying out (right side) -->
  <g class="request">
    <circle cx="240" cy="80" r="5" fill="#1a1a2e" />
    <text x="248" y="85" class="label" font-size="11">req</text>
  </g>
  <g class="request-2">
    <circle cx="240" cy="100" r="5" fill="#1a1a2e" />
  </g>
  <g class="request-3">
    <circle cx="240" cy="120" r="5" fill="#1a1a2e" />
  </g>

  <!-- Drain rate label -->
  <text x="250" y="240" text-anchor="middle" class="label" fill="#555570">Requests consume tokens</text>
  <text x="250" y="258" text-anchor="middle" font-size="10" fill="#8a8a9a">If bucket empty → 429 Too Many Requests</text>

  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="5" refY="3" orient="auto">
      <polygon points="0 0, 6 3, 0 6" fill="#1a1a2e" />
    </marker>
  </defs>
</svg>`;

export const urlShortenerFlow = `<svg viewBox="0 0 500 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="URL shortener base62 encoding flow">
  <defs>
    <style>
      .stage-box { fill: #fff5ec; stroke: #e85d04; stroke-width: 2; rx: 8; ry: 8; }
      .stage-text { font: 600 12px Inter, sans-serif; fill: #1a1a2e; text-anchor: middle; }
      .stage-num { font: 700 10px 'JetBrains Mono', monospace; fill: #e85d04; text-anchor: middle; }
      .arrow { fill: none; stroke: #1a1a2e; stroke-width: 2; }
      .anim-arrow { stroke-dasharray: 6 4; animation: flow 1.5s linear infinite; }
      @keyframes flow { to { stroke-dashoffset: -20; } }
      .label { font: 11px 'JetBrains Mono', monospace; fill: #555570; text-anchor: middle; }
    </style>
  </defs>

  <text x="250" y="22" text-anchor="middle" font-family="Inter" font-size="14" font-weight="600" fill="#1a1a2e">
    Base62 Encoding Pipeline
  </text>

  <!-- Stage 1: Long URL -->
  <g>
    <rect x="20" y="80" width="100" height="60" class="stage-box" />
    <text x="70" y="100" class="stage-num">1. INPUT</text>
    <text x="70" y="120" class="stage-text">Long URL</text>
  </g>

  <!-- Arrow 1 -->
  <line x1="120" y1="110" x2="160" y2="110" class="arrow anim-arrow" />
  <text x="140" y="100" class="label">hash</text>

  <!-- Stage 2: Counter -->
  <g>
    <rect x="160" y="80" width="100" height="60" class="stage-box" />
    <text x="210" y="100" class="stage-num">2. HASH</text>
    <text x="210" y="120" class="stage-text">SHA-256</text>
  </g>

  <!-- Arrow 2 -->
  <line x1="260" y1="110" x2="300" y2="110" class="arrow anim-arrow" />
  <text x="280" y="100" class="label">take 6 bytes</text>

  <!-- Stage 3: Base62 -->
  <g>
    <rect x="300" y="80" width="100" height="60" class="stage-box" />
    <text x="350" y="100" class="stage-num">3. ENCODE</text>
    <text x="350" y="120" class="stage-text">Base62</text>
  </g>

  <!-- Arrow 3 -->
  <line x1="400" y1="110" x2="440" y2="110" class="arrow anim-arrow" />

  <!-- Stage 4: Short code -->
  <g>
    <rect x="440" y="80" width="50" height="60" class="stage-box" fill="#e85d04" />
    <text x="465" y="105" class="stage-text" fill="white" font-size="10">3xK9aZ</text>
    <text x="465" y="125" class="stage-text" fill="white" font-size="9">short</text>
  </g>

  <text x="250" y="170" text-anchor="middle" font-size="11" fill="#555570">
    Counter (auto-increment) → mod 62^7 → map to [0-9a-zA-Z]
  </text>
</svg>`;

export const kafkaPartitionLog = `<svg viewBox="0 0 500 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kafka partition log">
  <defs>
    <style>
      .partition-box { fill: #fff5ec; stroke: #e85d04; stroke-width: 2; }
      .msg { fill: #e85d04; opacity: 0.85; }
      .msg-text { font: 600 9px 'JetBrains Mono', monospace; fill: white; text-anchor: middle; }
      .head { fill: #1a1a2e; }
      .label { font: 600 11px Inter, sans-serif; fill: #1a1a2e; }
      @keyframes append {
        0% { opacity: 0; transform: translateX(-20px); }
        100% { opacity: 0.85; transform: translateX(0); }
      }
      .msg-anim { animation: append 3s ease-in-out infinite; }
    </style>
  </defs>

  <text x="250" y="22" text-anchor="middle" font-family="Inter" font-size="14" font-weight="600" fill="#1a1a2e">
    Kafka Partition Log
  </text>

  <!-- Partition 0 -->
  <g>
    <text x="30" y="65" class="label">Partition 0</text>
    <rect x="30" y="75" width="440" height="40" class="partition-box" rx="3" />
    <rect x="30" y="75" width="36" height="40" class="msg" />
    <text x="48" y="100" class="msg-text">0</text>
    <rect x="68" y="75" width="36" height="40" class="msg" />
    <text x="86" y="100" class="msg-text">1</text>
    <rect x="106" y="75" width="36" height="40" class="msg" />
    <text x="124" y="100" class="msg-text">2</text>
    <rect x="144" y="75" width="36" height="40" class="msg" />
    <text x="162" y="100" class="msg-text">3</text>
    <rect x="182" y="75" width="36" height="40" class="msg" />
    <text x="200" y="100" class="msg-text">4</text>
    <rect x="220" y="75" width="36" height="40" class="msg" />
    <text x="238" y="100" class="msg-text">5</text>
    <!-- New messages being appended -->
    <rect x="258" y="75" width="36" height="40" class="msg msg-anim" />
    <text x="276" y="100" class="msg-text">6</text>
    <rect x="296" y="75" width="36" height="40" class="msg msg-anim" style="animation-delay: 1s" />
    <text x="314" y="100" class="msg-text">7</text>
  </g>

  <!-- Consumer offset arrow -->
  <g>
    <line x1="182" y1="135" x2="182" y2="155" stroke="#1a1a2e" stroke-width="2" />
    <polygon points="178,150 186,150 182,160" fill="#1a1a2e" />
    <text x="200" y="160" font-family="JetBrains Mono" font-size="10" fill="#555570">Consumer offset: 4</text>
  </g>

  <!-- Old/compacted -->
  <g>
    <rect x="30" y="180" width="440" height="40" class="partition-box" rx="3" opacity="0.4" />
    <text x="40" y="205" class="label" fill="#8a8a9a">Older messages (retention: 7 days, then deleted)</text>
  </g>

  <text x="250" y="255" text-anchor="middle" font-size="11" fill="#555570">
    Append-only · Immutable · Replicated across brokers
  </text>
</svg>`;
