---
title: "Authentication System (OAuth, JWT, SSO)"
type: system-design
category: Basics
date: 2026-05-05
tags: [system-design, interview, basics, authentication, oauth, jwt, sso]
---

# Authentication System (OAuth, JWT, SSO)

## Summary & Interview Framing

A system that verifies user identity and controls access using OAuth 2.0 (authorization), JWT (stateless tokens), and SSO (single login across services). It handles token issuance, refresh, and revocation, plus service-to-service authentication.

**How it's asked:** "Design an authentication system supporting OAuth, JWT tokens, and SSO for a platform with 100M users. Handle token refresh, revocation, and service-to-service auth."

---

## Overview

Authentication answers the question "who are you?" while authorization answers "what are you allowed to do?" These are separate concerns that interviewers deliberately conflate to test whether you recognize the boundary. In a system design interview, the authentication layer is the front door to every other component — a mistake here compromises the entire system regardless of how elegant your downstream architecture is. This note covers the full spectrum from the stateless HTTP problem through modern OAuth 2.0 and OpenID Connect flows, SSO architectures, password storage, token revocation, distributed session management, rate limiting, capacity planning, and the security trade-offs that govern each decision.

## The Fundamental Problem: HTTP Is Stateless

Every HTTP request is independent. The protocol carries no memory of previous requests from the same client, so without an explicit mechanism to anchor identity, users would need to re-authenticate on every single request. The web solved this with cookies, but cookies are just a transport — the real question is what you put inside them and where the authoritative state lives. Two architectures emerged: server-side sessions, where the server keeps a record and the cookie holds only a lookup key, and self-contained tokens, where the cookie or header carries a signed credential that the server can verify without any backing store. Each choice cascades into different trade-offs around revocation, scaling, latency, and cross-service propagation that define the rest of the design.

## Session-Based vs Token-Based Authentication

In a session-based architecture, the client posts credentials to a login endpoint, the server validates them and creates a session record in a database or cache, then returns a cookie containing only the session ID. On subsequent requests the browser attaches the cookie automatically, and the server performs a lookup to resolve the session to a user context. The strength of this model is revocation: deleting the session record immediately invalidates the credential, and because the payload is a short opaque string, there is no risk of leaking claims to the client. The weakness is scaling. In a multi-instance deployment you need either sticky sessions — which constrain load balancing and complicate failover — or a shared session store such as Redis, which becomes a network hop on every authenticated request and a single point of failure if not carefully replicated.

Token-based authentication flips the state ownership. The server issues a signed token — typically a JWT — that contains the user's identity and claims directly in the payload. The client presents this token on every request, usually in an Authorization header, and any server that holds the verification key can validate it locally without a database lookup. This is the natural fit for microservices and stateless APIs: identity propagates across service boundaries without a shared session store, and horizontal scaling is trivial because any instance can verify any token. The cost is revocation. A signed token is valid until its expiry, and there is no server-side record to delete. You must either keep tokens short-lived, maintain a denylist, or accept that a stolen token remains usable until it expires. The payload is also visible to the client — Base64 encoding is not encryption — so you must never place secrets inside a JWT.

The choice between sessions and tokens is rarely binary in production systems. A common hybrid pattern uses a short-lived access token for API calls paired with a refresh token stored in an HttpOnly cookie, giving you the stateless verification of tokens for hot-path requests while preserving server-side control over the refresh lifecycle. Another hybrid issues a JWT but tracks a session record keyed by the token's JTI for revocation and audit, checking it only on sensitive operations to avoid the per-request Redis hit.

### Session vs Token — Side by Side

| Dimension | Session-Based | Token-Based (JWT) |
|---|---|---|
| State location | Server-side store (Redis/DB) | Self-contained in the token |
| What the client holds | Opaque session ID (cookie) | Signed JWT (cookie or `Authorization` header) |
| Verification cost | Network lookup per request | Local CPU signature check |
| Revocation | Delete the record — immediate | Hard; needs short TTL, denylist, or introspection |
| Scaling | Needs shared store or sticky sessions | Trivial — any instance can verify |
| Payload visibility to client | Hidden (opaque ID) | Visible (Base64URL, not encrypted) |
| Cross-service propagation | Requires shared store or token exchange | Pass the token; verify locally |
| Best fit | Traditional web apps, monoliths | Microservices, stateless APIs, mobile/SPAs |
| Blast radius of token theft | Revoked instantly | Valid until `exp` or denylist propagation |
| Operational dependency | Session store must be HA | Verification key (JWKS) must be distributed |

## JWT Structure and Claims

A JSON Web Token is a compact, URL-safe string with three Base64URL-encoded segments separated by dots: header, payload, and signature. The header declares the signing algorithm and token type. The payload carries the claims — statements about the subject and the token's own metadata. The signature is computed over the header and payload using the declared algorithm and a secret or private key, producing a value the receiver can recompute to confirm integrity.

### JWT Structure Breakdown

```
  header            payload                       signature
  ┌─────────────┐   ┌───────────────────────────┐  ┌────────────────────────┐
  │ {           │   │ {                         │  │ HMAC-SHA256(            │
  │   "alg":    │   │   "sub":"1234567890",     │  │   base64url(header) +   │
  │    "RS256", │   │   "name":"John Doe",      │  │   "." +                 │
  │   "typ":"JWT"│  │   "iat":1516239022,       │  │   base64url(payload),   │
  │ }           │   │   "exp":1516242622,       │  │   private_key          │
  └─────────────┘   │   "iss":"auth.example",   │  │ )                      │
                    │   "aud":"api.example",    │  └────────────────────────┘
                    │   "jti":"a3f1b2c9"        │
                    │ }                         │
                    └───────────────────────────┘
          │                   │                          │
          ▼                   ▼                          ▼
   base64url(        base64url(                   base64url(
     header )          payload )                    signature )

   eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9 . eyJzdWIiOiIxMjM0... . SflKxwRJSMeKKF2QT4fwp...
   \_________________________ header _______________________/ \________ payload ______/ \____ sig ____/

   Decoded by receiver:
     1. Split on "."
     2. base64url-decode each segment
     3. Recompute signature over header.payload with the verification key
     4. Compare; if equal AND exp/nbf/aud/iss valid -> ACCEPT, else -> REJECT
```

Claims fall into three categories. Registered claims are the standard set defined by RFC 7519: `iss` (issuer), `sub` (subject, typically the user ID), `aud` (intended audience), `exp` (expiry timestamp), `nbf` (not-before timestamp), `iat` (issued-at timestamp), and `jti` (a unique token identifier used for deduplication and revocation). Private claims are application-specific, such as `roles`, `scope`, `tenant_id`, or `email_verified`. Public claims are registered in the IANA JWT claims registry to avoid collisions across systems. The receiver must validate not only the signature but also the `exp`, `nbf`, `aud`, and `iss` claims — a correctly signed token that has expired or was issued for a different audience is still invalid. A frequent mistake is verifying only the signature and trusting the payload unconditionally; claim validation is part of correctness, not an optional nicety.

A critical point for interviews: the payload is Base64URL-decoded, not encrypted. Anyone who intercepts the token can read every claim. If you need confidentiality, use JWE (JSON Web Encryption) rather than a standard signed JWT, or simply keep sensitive data out of the token and look it up server-side when needed. Tokens should be lean — including entire permission trees or large profile objects inflates every request and increases the blast radius of interception.

## JWT Signing Algorithms: HS256 vs RS256

The signing algorithm determines how the signature is produced and verified, and this choice has significant implications for key distribution and security. HS256 uses a symmetric secret shared between the issuer and all verifiers. The same key signs and validates, which is simple to deploy in a monolith but becomes a liability in a multi-service system: every service that verifies tokens holds the secret, and if any one of them is compromised the attacker can forge tokens for the entire platform. RS256 uses an asymmetric key pair. The authorization server signs with its private key; services verify with the public key, which can be freely distributed and cached. Compromising a verifier does not let an attacker mint tokens — only the private key can do that, and it lives in one tightly controlled place.

In practice, RS256 (or its stronger cousin RS512) is the standard for any system with more than one verifying service or any OAuth 2.0 authorization server, because it enforces separation of concerns: only the identity service can create identity assertions, while every other service can independently trust them. ES256, which uses elliptic curve cryptography, is gaining adoption because it produces smaller signatures with equivalent security, reducing token size for bandwidth-constrained environments. Regardless of algorithm, you must whitelist the expected algorithm server-side and reject tokens that declare anything else. The classic algorithm confusion attack exploits a server that naively trusts the `alg` header: an attacker takes an RS256-signed token, changes the header to `HS256`, and re-signs the payload using the server's public key as the HMAC secret — a key the attacker legitimately has access to. If the server accepts `HS256` and uses its RSA public key as the HMAC secret, the forgery validates. Pinning the algorithm per key eliminates this entire class of attack.

### JWT Signing Algorithm Comparison

| Algorithm | Key Type | Sign / Verify Keys | Compromise Impact | Token Size | Best Use Case |
|---|---|---|---|---|---|
| HS256 | Symmetric | Same secret signs & verifies | Any verifier compromise → attacker can forge tokens for the whole platform | Smallest | Single-service monolith, one verifier |
| RS256 | Asymmetric (RSA) | Private key signs; public key verifies | Verifier compromise ≠ token minting; only private key can forge | Larger (RSA signatures) | Multi-service systems, OAuth 2.0 AS |
| RS512 | Asymmetric (RSA) | Private key signs; public key verifies | Same as RS256, stronger | Largest | High-security enterprise tokens |
| ES256 | Asymmetric (ECDSA) | Private key signs; public key verifies | Same isolation as RS256 | Smaller than RS256 | Bandwidth-constrained, mobile, modern systems |
| ES512 | Asymmetric (ECDSA) | Private key signs; public key verifies | Same isolation | Medium | High-security, smaller than RS512 |
| none | — | No signature | Tokens can be tampered freely | Smallest | Never use for auth (debug only) |

**Algorithm confusion attack mitigation:** Pin the expected `alg` per key server-side and reject any token that declares a different algorithm. Never let the `alg` header choose the verification routine.

## Refresh Token Rotation

Access tokens should be short-lived — fifteen minutes to one hour — so that the window of exposure after theft is bounded. But forcing users to re-authenticate every fifteen minutes is unacceptable, so the system issues a longer-lived refresh token alongside the access token. When the access token expires, the client sends the refresh token to a token endpoint and receives a new access token without user interaction. This decouples the short exposure window of access tokens from the long convenience window of the session.

Refresh token rotation is the practice of issuing a brand-new refresh token every time the refresh endpoint is called and invalidating the old one. If an attacker steals a refresh token and uses it, the legitimate client's next refresh attempt fails because the token it holds has already been rotated out — the system detects the anomaly and can revoke the entire token family. Without rotation, a stolen refresh token remains valid for days or weeks, giving the attacker persistent access that silently survives password changes. The most robust implementation tracks token families: every refresh chain descends from an original login, and if a token from the middle of a chain is replayed, the entire family is revoked immediately on the assumption that the chain has been compromised. This is called automatic reuse detection and is the mechanism that makes refresh token rotation a security control rather than just a convenience feature.

### Refresh Token Rotation Flow

```
   LEGITIMATE CLIENT                                    ATTACKER IN POSSESSION OF RT_1
   ─────────────────                                    ──────────────────────────────

   1. Login ──────────────────────► Auth Server
      ◄──────── access_token(AT_1) + refresh_token(RT_1)

   2. AT_1 expires; send RT_1 ───► /token
      ◄──────── new AT_2 + new RT_2   (RT_1 invalidated, RT_2 issued)

   3. AT_2 expires; send RT_2 ───► /token
      ◄──────── new AT_3 + new RT_3   (RT_2 invalidated, RT_3 issued)

       ...rotation continues; each RT is single-use...


   ATTACK SCENARIO — RT_1 was stolen (e.g. from a leaked log):

   A. Attacker uses RT_1 ─────────► /token
      ◄──────── new AT_x + new RT_x   (server marks RT_1 as "used")

   B. Legit client still holds RT_1 (stale copy) ──► /token
      ◄──────── 400 REJECT: RT_1 already rotated!

   C. Server detects reuse of RT_1 ──► REVOKE ENTIRE TOKEN FAMILY
      (all descendants of the original login RT are invalidated)
      ├─ attacker's RT_x  ─► revoked
      └─ legit client forced to re-authenticate

   Token family lineage:
     login ─► RT_1 ─► RT_2 ─► RT_3 ─► RT_4 ─► ...
                ▲
                └── replay of any used token ⇒ kill the whole chain
```

Refresh tokens for public clients — SPAs and mobile apps that cannot hold a client secret — must be sender-constrained or use proof-of-possession mechanisms such as DPoP (Demonstrating Proof-of-Possession) or mTLS certificate-bound tokens, so that interception alone is not sufficient to use the token. For confidential clients with a backend, the refresh token is paired with the client secret at every refresh, adding a second factor that the browser never sees.

## OAuth 2.0 Flows

OAuth 2.0 is an authorization delegation framework, not an authentication protocol. It defines how a resource owner grants a client application access to their resources hosted on a resource server, without the client ever seeing the resource owner's credentials. The framework defines four roles — resource owner (the user), client (the application), authorization server (issues tokens), and resource server (hosts protected APIs) — and several grant types that suit different client profiles and trust levels.

```
   ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐
   │  Resource    │   │   Client     │   │  Authorization    │   │   Resource       │
   │   Owner      │   │ (app)        │   │    Server         │   │    Server        │
   │   (user)     │   │              │   │  (issues tokens)  │   │  (protected API) │
   └──────────────┘   └──────────────┘   └───────────────────┘   └──────────────────┘
```

### Authorization Code Flow

The authorization code flow is the workhorse of server-side web applications and the most secure of the user-facing flows. The user clicks a login link and is redirected to the authorization server's `/authorize` endpoint with the client ID, requested scopes, a redirect URI, and a random state value. The user authenticates with the authorization server and consents to the requested scopes. The authorization server redirects back to the client's pre-registered callback URI with a short-lived authorization code. The client's backend then exchanges this code at the `/token` endpoint, presenting the code along with its client secret, and receives the access and refresh tokens. The two-step indirection — code first, then token — keeps tokens off the browser's URL bar and front-end JavaScript. The code is single-use and expires within minutes, and the client secret never touches the browser. The state parameter binds the callback to the initiating request, preventing CSRF and authorization code injection attacks. This flow should be the default for any web application with a backend.

### Authorization Code with PKCE

PKCE (Proof Key for Code Exchange) extends the authorization code flow for public clients that cannot safely hold a client secret — single-page applications, mobile apps, and desktop applications. The client generates a high-entropy `code_verifier` and derives a `code_challenge` by hashing it (S256 method). The challenge is sent with the initial authorization request; the verifier is sent with the token exchange. The authorization server rejects the exchange if the verifier does not hash to the challenge it stored. This means that even if an attacker intercepts the authorization code — say, by abusing a custom URL scheme on a mobile device or a redirect on a malicious browser extension — they cannot complete the exchange because they do not have the verifier, which lives only in the client's memory. PKCE is now recommended for all OAuth 2.0 flows regardless of client type, and modern best-current-practice documents (OAuth 2.1) make it mandatory rather than optional.

### OAuth 2.0 Authorization Code Flow with PKCE

```
  ┌──────────────┐      ┌──────────────────┐      ┌───────────────────┐
  │  Resource    │      │  Client (SPA /   │      │ Authorization     │
  │   Owner      │      │  Mobile / Web)   │      │    Server         │
  │   (user +    │      │  — public client │      │                   │
  │   browser)   │      │  no client secret│      │                   │
  └──────┬───────┘      └────────┬─────────┘      └─────────┬─────────┘
         │                       │                          │
         │ 1. Client generates:                             │
         │    code_verifier  = random 43-128 char string    │
         │    code_challenge = BASE64URL(SHA256(verifier))  │
         │                       │                          │
         │ 2. Redirect to /authorize ──────────────────────►│
         │    ?response_type=code                            │
         │    &client_id=PUBLIC_CLIENT_ID                    │
         │    &redirect_uri=https://app/cb                   │
         │    &scope=openid profile                          │
         │    &state=RANDOM_CSRF_TOKEN                       │
         │    &code_challenge=BASE64URL(SHA256(verifier))    │
         │    &code_challenge_method=S256                    │
         │                       │                          │
         │ ◄─────── 3. Auth prompt + consent  ──────────────│
         │                       │                          │
         │ 4. User authenticates & consents ───────────────►│
         │                       │                          │
         │                       │ 5. Server stores         │
         │                       │    code_challenge        │
         │                       │    bound to the code     │
         │                       │                          │
         │ 6. Redirect back to callback ────────────────────│
         │    https://app/cb?code=AUTH_CODE                  │
         │              &state=RANDOM_CSRF_TOKEN             │
         │    (verify state == original)                     │
         │                       │                          │
         │                       │ 7. POST /token ─────────►│
         │                       │    grant_type=           │
         │                       │      authorization_code  │
         │                       │    code=AUTH_CODE        │
         │                       │    client_id=...         │
         │                       │    code_verifier=        │
         │                       │      <original verifier> │
         │                       │                          │
         │                       │ 8. Server checks:        │
         │                       │    BASE64URL(SHA256(     │
         │                       │      code_verifier))     │
         │                       │      == stored challenge?│
         │                       │    AND code unused?      │
         │                       │    AND not expired?      │
         │                       │                          │
         │                       │ ◄── 9. access_token ─────│
         │                       │     refresh_token        │
         │                       │     id_token (if OIDC)   │
         │                       │                          │
         │                       │ 10. Call API with        │
         │                       │     Authorization:       │
         │                       │       Bearer access_token│
         ▼                       ▼                          ▼

  Why PKCE helps:
    • Attacker steals AUTH_CODE (e.g. via malicious redirect/custom scheme)
    • Attacker calls /token with the code but CANNOT produce code_verifier
    • SHA256(verifier) ≠ stored challenge  →  exchange rejected
    • The verifier lives only in the client's memory — never on the wire
```

### Client Credentials Flow

The client credentials flow is for machine-to-machine communication where there is no user involved at all. A backend service authenticates directly to the authorization server with its client ID and secret — or a mutually authenticated TLS connection — and receives an access token scoped to its own permissions. This is how a scheduled job calls an internal API, how a microservice fetches a token to call another microservice, and how service-to-service authentication works in a zero-trust architecture. There is no refresh token in this flow because the client can simply request a new access token whenever it needs one using its own credentials. Scopes are assigned to the client itself rather than derived from a user session, and the authorization server enforces that the token's scopes are a subset of what the client is allowed to request.

## OpenID Connect

OpenID Connect is a thin identity layer built on top of OAuth 2.0. Pure OAuth 2.0 gives you an access token that authorizes API calls but tells you nothing reliable about who the user is — the access token is opaque to the client and is meant for the resource server. OIDC adds an `id_token`, which is a signed JWT containing identity claims such as `sub`, `email`, `name`, and `email_verified`, issued alongside the access token. The client can verify the id_token locally and use it to establish a session without calling the authorization server again. OIDC also defines a `/userinfo` endpoint for fetching richer profile information and a standard discovery mechanism via `/.well-known/openid-configuration` that publishes the server's endpoints, supported scopes, and signing keys. The `nonce` parameter binds the id_token to the authentication request, preventing token replay and injection. In modern systems, when someone says "login with Google" or "login with GitHub," they almost always mean OIDC, not raw OAuth 2.0 — the access token is a side effect; the id_token is the actual authentication artifact.

## SSO Architecture: SAML vs OIDC

Single sign-on allows a user to authenticate once with an identity provider and access multiple independent service providers without re-entering credentials. The two dominant protocols are SAML 2.0 and OIDC, and they reflect different eras of the web.

SAML 2.0 is XML-based and was designed for enterprise federated identity in the early 2000s. The flow can be service-provider-initiated — the user hits a service, gets redirected to the identity provider, authenticates, and is redirected back with a signed XML assertion — or identity-provider-initiated, where the user starts at a portal and clicks through to services they are already authorized for. SAML assertions are signed with XML digital signatures, which are notoriously easy to get wrong (XML signature wrapping attacks are a recurring vulnerability class), and the protocol's verbosity and tooling complexity make it expensive to implement from scratch. It persists in enterprise environments because of deep integration with corporate directories, Active Directory Federation Services, and legacy SaaS that only supports SAML. Okta, OneLogin, and Azure AD are the common identity providers.

OIDC-based SSO is the modern equivalent and uses the same OAuth 2.0 plus OIDC flows described above, with the identity provider acting as the authorization server and each service acting as an OIDC relying party. It is JSON-native, RESTful, dramatically simpler to implement, and works naturally with mobile apps and SPAs in ways SAML cannot. For greenfield systems, OIDC is the default choice. The main reason to choose SAML is a hard requirement to integrate with an existing enterprise identity provider or an application that only speaks SAML. Many identity providers support both, acting as a protocol bridge so that a single authentication event can produce either a SAML assertion or an OIDC id_token depending on what the downstream service expects.

### SSO Architecture — SAML 2.0 vs OIDC Side by Side

```
   ════════════════════════════════════════════════════════════════════════════
   SAML 2.0  (enterprise, XML, ~2005)              OIDC  (modern, JSON/REST)
   ════════════════════════════════════════════════════════════════════════════

   Service-Provider-initiated flow:              RP (Relying Party)-initiated flow:

   ┌──────────┐  ┌─────────┐  ┌────────┐         ┌──────────┐  ┌─────────┐  ┌────────┐
   │  User /  │  │ Service │  │Identity│         │  User /  │  │Relying  │  │Identity│
   │ Browser  │  │Provider │  │Provider│         │ Browser  │  │ Party   │  │Provider│
   │ (UA)     │  │  (SP)   │  │  (IdP) │         │ (UA)     │  │ (RP)    │  │  (IdP) │
   └────┬─────┘  └────┬────┘  └───┬────┘         └────┬─────┘  └────┬────┘  └───┬────┘
        │             │           │                    │             │           │
   1. GET /app ──────►│           │              1. GET /app ──────►│           │
        │             │           │                    │             │           │
        │ 2. 302 → IdP with                       2. 302 → /authorize with        │
        │    SAMLRequest (XML)                     client_id, redirect_uri,      │
        │    (signed AuthnRequest)                 scope=openid, state, nonce    │
        │  ─────────────────────────────►│         │  ─────────────────────────►│
        │             │           │                    │             │           │
        │ 3. IdP prompts user;                    3. IdP prompts user;           │
        │    user logs in                          user logs in + consents       │
        │             │           │                    │             │           │
        │ 4. 302 → SP ACS endpoint               4. 302 → callback with code    │
        │    SAMLResponse (signed XML ────────────│    + state ─────────────────►│
        │    assertion)          │           │         (RP verifies state)       │
        │ ◄──────────────────────│           │                    │             │
        │             │           │                    │             │           │
        │             │ 5. SP validates                │ 5. RP POSTs /token      │
        │             │    XML signature,              │    code → id_token +    │
        │             │    audience, time ─────────────────────────────────────►│
        │             │    → establishes session        │ ◄── id_token (JWT) +   │
        │             │           │                    │     access_token        │
        │             │           │                    │ 6. RP verifies JWT sig │
        │             │           │                    │    (JWKS), nonce, exp   │
        │             │           │                    │    → establishes session│
        ▼             ▼           ▼                    ▼             ▼           ▼

   Key artifacts:  signed XML <Assertion>            Key artifacts:  id_token (JWT) + access_token
   Binding:        HTTP-Redirect / POST / Artifact   Binding:        HTTP 302 redirects + JSON REST
   Identity claim: <saml:Subject> inside XML         Identity claim: sub/email in JWT payload
   Signing:        XML Digital Signature (DSig)      Signing:        JWS (HS256/RS256/ES256)
   Discovery:      SP metadata XML                   Discovery:      /.well-known/openid-configuration
   Logout:         LogoutRequest/LogoutResponse      Logout:         RP-initiated + back-channel (emerging)

   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Choose SAML when:  enterprise IdP (AD FS), legacy SaaS, no SPA/mobile    │
   │  Choose OIDC when:  greenfield, mobile/SPA, JSON-native, RESTful          │
   │  Many IdPs (Okta, Azure AD) bridge both: one login → either assertion     │
   └──────────────────────────────────────────────────────────────────────────┘
```

A design subtlety in SSO is the global logout problem. When a user logs out of one service, should they be logged out of all services? SAML defines partial solutions via `LogoutRequest` and `LogoutResponse` messages; OIDC has an emerging RP-initiated logout and back-channel logout spec, but neither is universally implemented. In practice, many SSO systems accept that logout is best-effort: the local session is destroyed, the SSO session at the identity provider is terminated, and relying parties are notified where possible, but a service that holds a long-lived local session or a valid access token may still serve the user until that token expires.

## Multi-Factor Authentication

Password-only authentication is insufficient for any system with meaningful attack surface. Multi-factor authentication requires the user to present evidence from at least two of three categories: something they know (a password or PIN), something they have (a device or hardware key), and something they are (a biometric). The most common second factor is a TOTP code generated by an authenticator app like Google Authenticator or Authy, based on a shared secret provisioned at enrollment via a QR code. TOTP is offline, standardized in RFC 6238, and free to operate, but it is phishable — a convincing login page can capture both the password and the one-time code.

The strongest factor types are phishing-resistant. WebAuthn and FIDO2 use public-key cryptography where the authenticator (a hardware key like YubiKey, or a platform authenticator like Touch ID or Windows Hello) signs a challenge from the relying party, bound to the origin of the request. Because the signature is origin-bound and never leaves the authenticator, a phishing site on a different domain cannot collect a valid assertion — the browser ensures the authenticator only signs for the real origin. Passkeys are the consumer-friendly packaging of this technology, synced across a user's devices via the platform's key chain, removing the "I lost my hardware key" problem while preserving phishing resistance. For high-security systems, WebAuthn with hardware keys is the gold standard; for consumer applications, passkeys or TOTP with push-based number matching are reasonable middle grounds.

A critical design consideration is step-up authentication: not every operation needs MFA. A user reading their dashboard can be satisfied by a single factor, while transferring money or changing account settings should require a second factor at the moment of the sensitive action, rather than gating every login. This reduces friction and MFA fatigue — the phenomenon where users approve every push notification without reading it because they are prompted too often. Number-matching push notifications, where the user must type a number displayed on the login screen into their phone, mitigate fatigue attacks by requiring active engagement.

## Password Storage

If your system still uses passwords — and most do — they must never be stored in plaintext or with reversible encryption. The standard is to hash passwords with a slow, deliberately expensive key-derivation function that includes a unique per-user salt. The salt defeats precomputed rainbow table attacks by ensuring that two users with the same password produce different hashes, and it should be stored alongside the hash since its purpose is uniqueness, not secrecy.

Bcrypt has been the long-standing default. It incorporates a salt and a configurable cost factor that determines how many rounds of the Blowfish cipher to run, making each hash verification deliberately slow — typically tens of milliseconds at cost factor 12. The cost factor is stored in the hash output, so you can increase it over time without re-architecting: when a user logs in, if their stored cost factor is below the current target, you re-hash the password they just provided at the new cost factor and replace the stored hash transparently. Bcrypt's weakness is a 72-byte input limit on the password, which can silently truncate long passphrases; modern implementations pre-hash with SHA-256 to avoid this, though that introduces its own subtle issues with null bytes.

Argon2id is the current recommendation from the Password Hashing Competition and the OWASP guidelines. It is memory-hard as well as CPU-hard, meaning it requires a significant amount of RAM to compute — this specifically defeats GPU and ASIC acceleration, which are how attackers parallelize bcrypt cracking at scale. Argon2id parameters include memory cost, time cost, and parallelism, all tunable to the target latency and available hardware. For new systems, Argon2id is the right default; for existing bcrypt systems, a migration plan that re-hashes on next login and eventually deprecates bcrypt is the path forward. PBKDF2 remains acceptable only when Argon2 and bcrypt are unavailable due to platform constraints, because it is faster to crack on GPUs than either alternative.

A related consideration is password breach detection. Services like HaveIBeenPwned offer a k-anonymity API where you send the first five characters of a password hash and receive suffixes to compare locally, allowing you to reject passwords that appear in known breach corpora without ever sending the full password to a third party. This is cheap insurance that significantly improves the effective strength of user-chosen passwords.

## Rate Limiting Auth Endpoints

Authentication endpoints are the primary target for credential stuffing, brute force, and account takeover attacks, and they must be rate limited with more rigor than ordinary API endpoints. The strategy should be layered. At the network edge, a WAF or CDN applies IP-based rate limiting to blunt volumetric attacks and distribute the load across edge points of presence. At the application layer, rate limiting should be keyed to multiple dimensions: per IP address to catch distributed attacks from a single source, per account (email or username) to catch targeted brute force against a specific user, and per device fingerprint or client identifier to catch attacks that rotate across IP addresses via botnets. A single dimension is insufficient — an attacker behind a rotating proxy defeats IP-only limits, and an attacker rotating target usernames defeats account-only limits.

When a limit is exceeded, the system should not simply return a 429 and stop. It should implement progressive delays or exponential backoff in the response, return a Retry-After header, and optionally trigger a CAPTCHA or require MFA for subsequent attempts — escalating friction rather than hard-blocking, which can lock out legitimate users during an attack against their account. Account lockout policies must be designed carefully: a permanent lockout after a small number of failed attempts creates a denial-of-service vector where an attacker intentionally locks out accounts by spraying wrong passwords. Time-based lockouts (five minutes after five failures) or adaptive lockouts that scale with the attack pattern are safer. All failed login attempts should be logged with enough context — IP, user agent, timestamp, target account — to feed anomaly detection and enable post-incident forensics, but without logging the password or password hash.

A particularly dangerous endpoint that is often overlooked is the password reset flow. The reset-request endpoint can be abused to enumerate accounts (different responses for existing vs non-existing emails) or to flood a victim's inbox with reset emails. The token-validation and token-consumption endpoints must rate limit per token and per account to prevent brute force of the reset token itself, and reset tokens must be single-use, short-lived, and invalidated on use.

## Token Revocation

The fundamental tension in JWT-based systems is that a correctly signed token is valid until its `exp` claim, and there is no server-side record to delete. This means that logout, session termination, credential compromise, and role-change propagation all require an explicit revocation strategy on top of the base JWT.

The simplest approach is to keep access tokens very short-lived — fifteen minutes or less — so that revocation is effectively achieved by waiting out the expiry. This is acceptable for many systems but does not help when you need immediate termination, such as when an employee is terminated or a token is known to be compromised. For immediate revocation, the standard pattern is a denylist in a fast, shared store like Redis, keyed by the token's `jti` claim. On logout or revocation, the JTI is written to the denylist with a TTL equal to the token's remaining lifetime, so the entry self-expires when the token would have expired anyway, bounding the memory cost. Every verifying service checks the denylist before accepting a token, which reintroduces the per-request Redis lookup that stateless JWTs were supposed to eliminate. To mitigate this, services can cache denylist checks with a short TTL — accepting that a revocation takes up to that TTL to propagate — or only check the denylist for high-risk operations, trusting short token lifetimes for ordinary requests.

Refresh token revocation is simpler and more impactful because refresh tokens are long-lived and few in number. Maintaining a server-side record of all issued refresh tokens — or at least their IDs and status — allows you to revoke a session by deleting or marking its refresh token invalid, which prevents renewal of the access token and effectively ends the session at the next access-token expiry. This is why the hybrid pattern of stateless access tokens plus stateful refresh tokens is so common: it preserves local verification for hot-path requests while keeping a server-side control point for the lifecycle decisions that matter.

For OAuth 2.0, RFC 7009 defines a standard token revocation endpoint that clients can call to invalidate access and refresh tokens. RFC 8417 defines token revocation events via SET (Security Event Tokens) for back-channel notification, allowing an authorization server to push revocation events to resource servers in near-real-time rather than relying on poll-based denylist checks. These mechanisms are increasingly important in enterprise deployments where a compromised token must be killed across dozens of downstream services within seconds.

## Distributed Session Management

In a single-instance deployment, session management is trivial — store sessions in local memory. The moment you have more than one instance, you face the question of how a request hitting instance B can validate a session created on instance A. Three architectural options address this, each with different trade-offs.

Sticky sessions use a load balancer to route all requests from a given client to the same instance that issued the session, keeping the session in local memory. This is simple but fragile: if that instance dies, the user is logged out; scaling out requires redistributing sessions; and it couples load balancing to session state rather than letting the balancer optimize for capacity. It is acceptable only for small systems with tolerant users.

A shared session store externalizes session state to a clustered cache such as Redis or Memcached. Every instance reads and writes sessions to the shared store, so any instance can serve any request. This is the standard approach for session-based architectures at scale, but it adds a network hop to every authenticated request and makes the session store a critical dependency that must be highly available. Redis Cluster or a replicated Memcached pool handles the availability requirement, but the latency cost remains — typically one to three milliseconds per request in a well-tuned setup, which adds up across a deep microservice call chain.

For token-based architectures, distributed session management is largely a non-issue for the access token itself, because verification is local. The distributed state that remains is the refresh token store and the denylist, both of which are low-frequency (refresh happens hourly or less; denylist checks can be cached) and tolerate the network hop. The most sophisticated pattern is token introspection via RFC 7662, where resource servers call a centralized introspection endpoint on the authorization server to validate opaque tokens and get back their active status and claims. This centralizes control but reintroduces the per-request dependency, so it is typically paired with short-lived caching of introspection results.

A subtlety in distributed session management is clock skew. JWT validation depends on `exp`, `nbf`, and `iat` timestamps, and if different services have clocks that drift by more than a few seconds, tokens may be rejected as not-yet-valid or accepted past their intended expiry. Production systems must run NTP or a comparable time synchronization service on every node and configure a small leeway (typically 30 to 60 seconds) in JWT validators to absorb minor drift. This is an operational concern that interviewers probe to test whether you have shipped auth to production, not just designed it on a whiteboard.

## Security Considerations

Beyond the specific mechanisms above, several cross-cutting security principles govern authentication system design. The principle of least privilege applies to scopes and claims: a token should carry only the permissions the current operation needs, not the user's full permission set. Service-to-service tokens should be scoped to the calling service's role, and user tokens propagated to downstream services should be exchanged for service-scoped tokens with reduced claims rather than passed through verbatim. This limits blast radius — if a downstream service is compromised, the attacker holds only that service's scoped token, not the user's full identity.

Token transport security is non-negotiable. Tokens must travel over HTTPS exclusively, with HSTS enforced to prevent protocol downgrade. Cookies must carry the `Secure` flag (never sent over HTTP), the `HttpOnly` flag (inaccessible to JavaScript, mitigating XSS token theft), and the `SameSite` attribute set to `Lax` or `Strict` to mitigate CSRF. For APIs that use bearer tokens in headers, CORS must be configured to restrict which origins can make authenticated requests, since a permissive CORS policy lets any website make authenticated requests on behalf of a logged-in user.

Redirect URI validation in OAuth flows must be exact-match against pre-registered values, not prefix or wildcard match. Open redirectors and permissive matching have been the root cause of numerous real-world token theft incidents, including high-profile breaches at major platforms. The state parameter must be a cryptographically random value generated per request and validated on callback, not a static or predictable value. Client secrets for confidential clients must be stored in a secrets manager — not in source code, not in environment files in the repository, not in CI logs — and rotated on a regular schedule and on personnel turnover.

Logging and monitoring must capture authentication events without capturing credentials. Every login, failed attempt, token issuance, token refresh, and revocation should be logged with enough context to reconstruct an attack timeline. Anomaly detection on these events — impossible travel (a login from New York and one from Tokyo an hour later), velocity spikes (thousands of failed logins against one account), and geographic outliers — should trigger automated responses ranging from step-up MFA to temporary account freeze. These signals feed into a SIEM for correlation across services and into automated incident response for containment.

Finally, defense in depth: no single control is sufficient. A system that relies only on passwords fails when passwords leak. A system that relies only on JWTs fails when a token is stolen. A system that relies only on rate limiting fails when the attack comes from a slow, distributed source. Layering password hashing, MFA, short token lifetimes, rotation, denylists, rate limiting, anomaly detection, and network-level controls means that the failure of any one control does not compromise the system.

### Authentication Security Checklist

**Least privilege & token design**
- [ ] Tokens carry only the scopes/claims needed for the current operation — never the user's full permission set
- [ ] Service-to-service tokens are scoped to the calling service's role
- [ ] User tokens are exchanged for service-scoped tokens at service boundaries, not passed through verbatim
- [ ] Tokens stay lean — no entire permission trees or large profile objects in the payload
- [ ] Sensitive data kept server-side; JWE used only when confidentiality is truly required

**Token transport**
- [ ] All token traffic over HTTPS exclusively
- [ ] HSTS enforced to prevent protocol downgrade
- [ ] Cookies carry `Secure` flag
- [ ] Cookies carry `HttpOnly` flag (mitigates XSS token theft)
- [ ] Cookies set `SameSite=Lax` or `Strict` (mitigates CSRF)
- [ ] CORS configured to restrict which origins can make authenticated requests
- [ ] Never place secrets inside a JWT payload (Base64 ≠ encryption)

**OAuth flow hardening**
- [ ] Redirect URIs validated by exact match against pre-registered values — no prefix/wildcard
- [ ] `state` parameter is a cryptographically random per-request value, validated on callback
- [ ] PKCE (`code_verifier` / `code_challenge`) used on all authorization code flows
- [ ] `nonce` parameter used for OIDC id_tokens to bind them to the auth request
- [ ] Authorization codes are single-use and short-lived (minutes)
- [ ] Client secret never touches the browser; stored in a secrets manager, not source/env/CI logs
- [ ] Client secrets rotated on a schedule and on personnel turnover

**JWT verification**
- [ ] Algorithm pinned per key server-side — reject tokens declaring any other `alg`
- [ ] Defend against algorithm confusion (RS256 public key reused as HS256 secret)
- [ ] Validate `exp`, `nbf`, `aud`, and `iss` claims — not just the signature
- [ ] Clocks synchronized via NTP; small leeway (30–60s) configured in validators
- [ ] Verification keys fetched from JWKS and cached locally for the key-rotation TTL

**Revocation & lifecycle**
- [ ] Access tokens short-lived (15 min–1 hr) to bound exposure
- [ ] Refresh token rotation enabled with automatic reuse detection
- [ ] Token families tracked; replay of a used token revokes the whole family
- [ ] Denylist in Redis keyed by `jti`, TTL = remaining token lifetime
- [ ] Refresh tokens for public clients are sender-constrained (DPoP / mTLS)
- [ ] RFC 7009 revocation endpoint and/or RFC 8417 SET back-channel events for enterprise

**Password storage**
- [ ] Passwords never stored plaintext or reversibly encrypted
- [ ] Argon2id used for new systems (memory-hard + CPU-hard); bcrypt for legacy with migration plan
- [ ] Unique per-user salt stored alongside the hash
- [ ] Cost factor tunable and stored in the hash output; re-hash on next login when raising it
- [ ] Bcrypt 72-byte limit handled (e.g. pre-hash with SHA-256) to avoid silent truncation
- [ ] Breach detection via k-anonymity API (e.g. HaveIBeenPwned) to reject known-breached passwords

**MFA**
- [ ] MFA required for any system with meaningful attack surface
- [ ] Phishing-resistant factor (WebAuthn/FIDO2/passkeys) for high-security systems
- [ ] Step-up auth for sensitive operations rather than gating every login
- [ ] Number-matching push notifications to mitigate MFA fatigue
- [ ] TOTP accepted as a middle ground; SMS avoided where possible

**Rate limiting & lockout**
- [ ] Layered rate limiting: WAF/CDN at the edge, app-layer keyed per IP, per account, per device
- [ ] Progressive delays / exponential backoff + `Retry-After` on exceeded limits
- [ ] CAPTCHA or MFA escalation on repeated failures rather than hard block
- [ ] Time-based or adaptive lockouts (not permanent lockout after few failures — DoS vector)
- [ ] Password-reset endpoints rate-limited per token and per account; tokens single-use and short-lived
- [ ] Identical responses for existing vs non-existing emails (no account enumeration)

**Logging & monitoring**
- [ ] Every login, failure, issuance, refresh, and revocation logged with context (IP, UA, timestamp, account)
- [ ] Passwords and password hashes never logged
- [ ] Anomaly detection: impossible travel, velocity spikes, geographic outliers
- [ ] Automated responses: step-up MFA, temporary account freeze
- [ ] Events fed into a SIEM for cross-service correlation and incident response

**Defense in depth**
- [ ] No single control relied upon in isolation
- [ ] Password hashing + MFA + short token lifetimes + rotation + denylists + rate limiting + anomaly detection + network controls layered together
- [ ] Failure of any one control does not compromise the system

## Capacity Planning

Authentication systems are peculiar in capacity planning because their load is bursty and correlated with human behavior. Login traffic spikes at the start of business hours in each timezone, after major incidents that trigger password resets, and during marketing events that drive new sign-ups. The system must handle peak burst load, not average load, because authentication is on the critical path — if login is slow or fails, the user cannot reach anything else.

The primary resource consumers are the password hashing function and the token signing operation. Argon2id at reasonable parameters consumes 50 to 100 milliseconds of CPU and tens of megabytes of RAM per hash. If the system processes 1,000 logins per second at peak, password hashing alone requires 50 to 100 CPU-seconds of work per second — meaning 50 to 100 cores dedicated to login, before any other processing. This is not a bug; it is the intended cost that makes offline cracking expensive. But it means login capacity must be provisioned to peak, not average, and the hashing parameters must be tuned so that single-login latency stays under a few hundred milliseconds while aggregate throughput meets the peak. Token signing with RS256 is cheaper but still non-trivial — a few milliseconds per sign — and signing capacity scales with the number of tokens issued, which includes every login and every refresh.

The shared state stores — Redis for sessions and denylists, the database for refresh token records and user credentials — must be sized for both read and write throughput at peak, with replication for availability and connection pooling to absorb connection churn. Cache hit ratios matter: a well-tuned session store should see 99%+ cache hits, with database writes only on login, logout, and refresh. The authorization server's key distribution endpoint (JWKS, the JSON Web Key Set) is read-heavy and globally cacheable, and services should cache keys locally with a TTL that matches the key rotation cadence — typically hours to days — to avoid a per-token network call for key material.

A capacity planning rule of thumb: provision auth infrastructure to 3 to 5x average load, keep token lifetimes and caching tuned so that the hot path is stateless verification, and ensure that the only per-request stateful operations (session or denylist lookups) are served from an in-memory cache with a sub-millisecond p99. Run load tests against the login flow specifically, not just the API, because the login flow exercises the most expensive code paths (hashing, signing, session creation) and is the most sensitive to latency — users will abandon a login that takes more than two to three seconds. Chaos testing should include failure of the session store and the authorization server to verify that failover is transparent and that token verification continues to work during the outage, since local JWT verification is specifically designed to tolerate authorization server downtime.

## Interview Question

**Q: Design an authentication system for a microservices architecture. A user logs in once and needs to access 10 different downstream services. How do you propagate identity, and how do you handle revocation?**

**Model Answer:**

The login is handled by a dedicated identity service acting as the OAuth 2.0 authorization server and OpenID Connect provider. On successful authentication — password verified against an Argon2id hash, MFA satisfied if required — the service issues a short-lived access token (15 minutes, RS256-signed JWT) and a longer-lived refresh token stored as a server-side record keyed by a random ID. The access token's payload carries the user ID, a minimal set of scopes, and a JTI. The refresh token is returned in an HttpOnly, Secure, SameSite=Strict cookie; the access token is returned to the client for use in API calls.

For service-to-service propagation, the raw user token is not passed to all 10 downstream services. Instead, the API gateway or the calling service exchanges the user token for a service-scoped token by calling the authorization server's token endpoint with the client credentials of the downstream service, requesting only the scopes that service needs. This means each downstream service receives a token with claims scoped to its responsibilities — the billing service sees the user ID and a `billing:read` scope; the notification service sees only a pseudonymous identifier and a `notify:send` scope. This follows least privilege and limits the blast radius of compromise.

Each downstream service verifies its received JWT locally using the authorization server's public key, fetched from the JWKS endpoint and cached locally for the key rotation TTL. This is a pure CPU operation with no network call on the hot path. The services also validate the `exp`, `aud`, and `iss` claims and reject tokens whose algorithm is not RS256, defending against algorithm confusion attacks.

Revocation operates at two levels. For ordinary logout, the refresh token record is deleted from the database, which prevents the client from obtaining new access tokens; the current access token expires naturally within 15 minutes, which is an acceptable window for most use cases. For immediate revocation — a compromised token, a terminated employee — the token's JTI is written to a Redis denylist with a TTL equal to the token's remaining lifetime, and every service checks this denylist on each request (cached for a few seconds to limit Redis load). For refresh token theft, automatic reuse detection in the rotation logic revokes the entire token family when a replay is detected.

The system is stateless on the hot path (local JWT verification), stateful at the control points (refresh token store, denylist), and degrades gracefully: if Redis is down, services fall back to trusting short token lifetimes and fail open on denylist checks (accepting the small revocation-delay risk) rather than failing closed and locking out all users. The identity service and the session store are the only components that need to be highly available for login to work; all downstream services continue to validate existing tokens even if the identity service is temporarily down, because they hold the public key locally.

**Common Pitfall:**

Candidates frequently propose passing the user's access token directly to every downstream service. This is wrong for two reasons. First, it gives every service the user's full scope set, violating least privilege — if any of the 10 services is compromised, the attacker holds a token that can do everything the user can do across the entire platform. Second, it makes revocation harder, because the token is now spread across multiple service boundaries and cached in multiple places. The correct pattern is token exchange: mint a fresh, service-scoped token for each downstream call, so that compromise of one service yields only that service's minimal scopes and revocation is centralized at the authorization server. Interviewers are testing whether you understand that identity propagation is not just about moving a token from A to B, but about progressively narrowing trust as you cross service boundaries.

---

## Interview Cheat Sheet

**Key Points to Remember:**
- OAuth 2.0 = authorization (what can you do), JWT = stateless token format, SSO = one login for multiple services
- JWT has three parts: header, payload, signature — all base64-encoded, separated by dots
- JWT is stateless: no server-side session lookup, but tokens can't be revoked until they expire
- Access tokens are short-lived (15-60 min); refresh tokens are long-lived (days/weeks) and stored server-side
- For microservices: use token exchange — mint a service-scoped token for each downstream call, never pass the user's token

**Common Follow-Up Questions:**
- "How do you revoke a JWT before it expires?" — You can't truly revoke a stateless token. Use a revocation list (blocklist) checked on each request, or keep tokens very short-lived.
- "What's the difference between SSO and OAuth?" — SSO is the user experience (log in once, access everything). OAuth is the protocol that can enable SSO, but OAuth alone is authorization, not authentication.

**Gotcha:**
- JWT is not encrypted by default — it's signed. Anyone who intercepts it can read the payload. Never put sensitive data (passwords, PII) in a JWT payload. If confidentiality is needed, use JWE (JSON Web Encryption), not just JWS.
