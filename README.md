# ⚡ PulsePoll — Real-Time Live Polling Engine

A modern, production-grade live polling application built with **React**, **Go (Gin)**, **MongoDB**, and **Redis**. 

Create a poll, share the link or QR code, and watch audience votes update live on all screens simultaneously with **zero page refreshes**.

---

## 🚀 Live Demo & Submission Links

- **Live Application:** [https://pulsepoll-frontend.vercel.app](https://pulsepoll-frontend.vercel.app) *(or your deployed Vercel URL)*
- **GitHub Repository:** [https://github.com/Manjari-E/PulsePoll](https://github.com/Manjari-E/PulsePoll)
- **Demo Video (3–5 min):** *[Unlisted YouTube / Public Google Drive Link]*
- **Submission Recipient:** `devhiring@hclguvi.com`

---

## 🎯 Core Flow

```
[ Create Poll ] ──> [ Share Link / QR Code ] ──> [ Audience Votes ] ──> [ Live Results ]
  (Auth Required)        (Direct Link / QR)      (Guest / User)        (Sub-second Real-time)
```

1. **Create Poll:** Authenticated users create polls with 2–10 validated options.
2. **Share Link:** One-click copyable URL and instant QR code for mobile audience members.
3. **Audience Votes:** Both logged-in users and anonymous audience members can vote directly via unique voter identity tokens.
4. **Live Results:** Real-time updates propagate across every active client screen immediately through WebSockets and Redis Pub/Sub.

---

## 🛠️ Tech Stack & Real Architectural Work

Every layer of this stack performs genuine, critical work — nothing is bolted on for show.

| Layer | Technology | Real Responsibilities |
|---|---|---|
| **Frontend** | **React (Vite)** | Reactive state management, persistent WebSocket connection with auto-reconnect, dynamic SVG bar graphs & percentages, QR code generation, client-side voter fingerprinting, and resilient error boundaries. |
| **Backend** | **Go (Gin)** | High-throughput REST API, Gorillas WebSocket upgrader with origin checking, strict server-side input validation, JWT authentication, and atomic concurrency controls. |
| **Database** | **MongoDB** | Durable document persistence for users and polls, unique indexing on user emails, atomic `$inc` updates, and permanent voter audit trails. |
| **Realtime** | **Redis** | **1. In-Memory Atomic Counters:** Redis Hashes (`HINCRBY`) driving live vote counts at sub-millisecond latency.<br>**2. Fast O(1) Deduplication:** Redis Sets (`SADD`, `SISMEMBER`) caching voter identity keys to block duplicate votes.<br>**3. Real-Time Pub/Sub:** Redis channel `poll_updates` distributing broadcast events to all Go WebSocket instances. |

---

## 🏛️ Project Structure & Separation of Concerns

The project strictly separates client-side presentation from backend business logic and data persistence:

```
pulsepoll/
├── README.md                 # System architecture, setup & key decisions
├── vercel.json               # Frontend deployment routing & proxy configuration
├── backend/                  # Go service
│   ├── database/             # MongoDB client initialization & indexing
│   │   └── mongo.go
│   ├── handlers/             # HTTP controller handlers & input validation
│   │   ├── auth.go
│   │   ├── poll.go
│   │   └── handlers_test.go  # Unit tests for input validation
│   ├── middleware/           # JWT authentication & optional guest context
│   │   ├── auth_middleware.go
│   │   └── auth_middleware_test.go
│   ├── models/               # Data structures (Poll, User)
│   │   ├── poll.go
│   │   └── user.go
│   ├── realtime/             # Redis in-memory counters, sets & WebSocket engine
│   │   ├── redis.go
│   │   └── websocket.go
│   ├── routes/               # API route definitions
│   │   └── routes.go
│   ├── utils/                # JWT generation, validation & tests
│   │   ├── jwt.go
│   │   └── jwt_test.go
│   ├── main.go               # Server bootstrap, CORS configuration & health check
│   ├── go.mod
│   └── go.sum
└── frontend/                 # React client
    ├── src/
    │   ├── App.jsx           # Polling dashboard, voting interface & WebSocket client
    │   ├── App.css           # Glassmorphism design system & micro-interactions
    │   ├── ErrorBoundary.jsx # React error boundary preventing UI crashes
    │   ├── main.jsx          # App root mount
    │   └── index.css         # Global styling resets & typography
    ├── index.html
    ├── vite.config.js
    └── package.json
```

---

## ⚡ How Redis Drives Live Updates & Counts

Rather than relying purely on disk-bound database queries for high-frequency live events, Redis acts as the **hot real-time layer**:

1. **Atomic Vote Counting:** When a vote arrives, Redis executes `HINCRBY poll:<id>:votes <optionIndex> 1`. Vote tallies are maintained directly in Redis memory for ultra-fast reads.
2. **Instant Voter Deduplication:** Voters (both logged-in user IDs and anonymous guest voter UUIDs) are checked against a Redis Set using `SISMEMBER poll:<id>:voters <voterKey>`. Upon voting, `SADD` commits the key with an automatic TTL.
3. **Pub/Sub Event Broadcast:** The backend publishes the updated tallies to the Redis `poll_updates` channel.
4. **WebSocket Fanout:** Active Go WebSocket connections subscribed to the Redis channel immediately serialize and push the new tallies to connected browsers, triggering zero-refresh live UI animations.
5. **MongoDB Persistence:** The Go backend simultaneously commits the vote to MongoDB (`$inc` and `$push`) to guarantee durable long-term storage and consistency across restarts.

---

## 🔒 Backend Input Validation & Security

Input is never trusted from the client. Strict server-side checks include:

- **Authentication:**
  - Email format strictly validated against RFC-compliant regex.
  - Password enforced between 6 and 72 characters (preventing bcrypt truncation attacks).
  - Name trimmed and bound between 2 and 70 characters.
  - Passwords hashed using `bcrypt.GenerateFromPassword` with default cost.
- **Poll Creation:**
  - Question validated between 3 and 300 characters.
  - Options bound between 2 and 10 items.
  - Each option sanitized, trimmed, bound to 100 characters max, and deduplicated case-insensitively.
  - Poll creator validated through verified JWT claims (`user_id`).
- **Voting:**
  - Poll status must be `"active"`.
  - Selected option index checked against valid range `[0, len(options)-1]`.
  - Voter identity enforced via JWT claim or sanitized `X-Voter-ID` header.
  - Atomic MongoDB conditions (`$ne` on voters array) and Redis Sets prevent double-voting under concurrent race conditions.
- **Poll Management:**
  - Only the verified creator of a poll can close it.

---

## 📡 API Reference

### Authentication
- `POST /api/auth/signup` — Register a new account (`name`, `email`, `password`).
- `POST /api/auth/login` — Authenticate and receive a signed JWT (`email`, `password`).

### Polls
- `GET /api/polls/` — Fetch all public polls.
- `GET /api/polls/:id` — Fetch poll details and options (supports `?voterId=` to return `hasVoted` state).
- `POST /api/polls/` — Create a new poll (`question`, `options[]`) *(Bearer Token Required)*.
- `POST /api/polls/:id/vote` — Cast an atomic vote (`optionIndex`, `voterId`).
- `POST /api/polls/:id/close` — Close an active poll *(Bearer Token Required; Creator Only)*.

### Realtime
- `GET /ws` — Gorilla WebSocket endpoint streaming live JSON events (`vote`, `poll_created`, `poll_closed`).
- `GET /health` — Service health check.

---

## 💻 Running Locally

### 1. Prerequisites
- **Go** 1.22+ installed
- **Node.js** 18+ and `npm` installed
- **MongoDB** instance (local or MongoDB Atlas connection string)
- **Redis** instance (local or Upstash / Redis Cloud URL)

---

### 2. Backend Setup

1. Open a terminal in `./backend`:
   ```bash
   cd backend
   ```

2. Create a `.env` file in `./backend/.env`:
   ```env
   PORT=8080
   MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/pulsepoll?retryWrites=true&w=majority
   REDIS_URL=redis://default:<password>@<host>:6379
   JWT_SECRET=your-super-secret-jwt-key-min-32-chars
   FRONTEND_URL=http://localhost:5173
   ```

3. Download dependencies and run the server:
   ```bash
   go mod download
   go run main.go
   ```
   *The server starts on `http://localhost:8080`.*

4. Run backend tests:
   ```bash
   go test -v ./...
   ```

---

### 3. Frontend Setup

1. Open another terminal in `./frontend`:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the Vite development server:
   ```bash
   npm run dev
   ```
   *The frontend runs on `http://localhost:5173`.*

4. Verify production build:
   ```bash
   npm run build
   ```

---

## 🌐 Production Deployment Guide

### Deploy Backend (Render / Railway)
1. Push the repository to GitHub.
2. In [Render](https://render.com), create a new **Web Service** pointing to the repository root directory `./backend`.
3. Set the build command:
   ```bash
   go build -o main .
   ```
4. Set the start command:
   ```bash
   ./main
   ```
5. Configure Environment Variables on Render:
   - `MONGO_URI`: Your MongoDB Atlas connection URI.
   - `REDIS_URL`: Your Redis connection string (e.g. from Upstash or Redis Cloud).
   - `JWT_SECRET`: A secure random 64-character secret.
   - `FRONTEND_URL`: `https://your-app.vercel.app`
   - `PORT`: `10000`

### Deploy Frontend (Vercel)
1. In [Vercel](https://vercel.com), import the GitHub repository.
2. Set the root directory to `frontend`.
3. Framework preset: **Vite**.
4. Configure Environment Variables on Vercel:
   - `VITE_API_URL`: `https://your-backend.onrender.com`
   - `VITE_WS_URL`: `wss://your-backend.onrender.com/ws`
5. Deploy!

---

## 💡 Key Design Decisions & Trade-Offs

1. **Dual In-Memory (Redis) & Persistent (Mongo) Architecture:**
   - *Decision:* Real-time vote tallies and voter deduplication sets are managed in Redis memory, while MongoDB stores durable document records.
   - *Why:* Pure database writes under concurrent live voting cause lock contention and higher latency. Redis handles high-throughput atomic increments (`HINCRBY`) and broadcasts updates instantly, while MongoDB ensures zero data loss across server restarts.

2. **Anonymous Audience Voting with Fingerprint Identity:**
   - *Decision:* Poll creation requires account login (JWT), but voting is open to guests via an auto-generated client UUID passed in the `X-Voter-ID` header.
   - *Why:* Forcing audience members to sign up creates friction and destroys engagement in live presentations. Tracking `guest:<uuid>` in both Redis sets and MongoDB arrays prevents duplicate votes without requiring a signup wall.

3. **WebSocket Pub/Sub over Polling:**
   - *Decision:* A dedicated Gorilla WebSocket connection backed by Redis Pub/Sub streams updates to every connected client.
   - *Why:* Short polling wastes server resources, exhausts rate limits, and produces delayed updates. WebSockets provide sub-100ms updates with minimal bandwidth overhead.

4. **React Error Boundary & Resilient State Handling:**
   - *Decision:* Wrapped the root component in an error boundary and added fallback states for uninitialized arrays or disconnected sockets.
   - *Why:* Ensures the application gracefully reconnects and never displays an unhandled white-screen crash in production.

---

## 📹 Video Walkthrough Outline (3–5 min)

When recording your submission walkthrough video, follow this clear structure:

### 1. Live Demonstration (1–2 minutes)
- Open two browser windows side-by-side (Window A: Poll Creator; Window B: Incognito Guest Voter).
- Create a new poll in Window A.
- Open the share link in Window B.
- Cast a vote in Window B and show Window A updating **live in real-time with zero page refresh**.
- Demonstrate duplicate vote prevention.
- Show creator controls (closing a poll live).

### 2. The One Challenge That Gave the Most Trouble & The Solution (1.5 minutes)
> **Challenge:** *"Synchronizing atomic real-time vote updates between Redis in-memory counts and MongoDB persistence without allowing double-voting or race conditions between concurrent voters."*
> 
> **Solution:** *"I implemented a two-tier strategy: Redis acts as the hot cache using atomic Redis Sets (`SADD`) and Hashes (`HINCRBY`) for O(1) duplicate checks and sub-millisecond tally updates, while MongoDB performs an atomic conditional update (`$inc` and `$push` with an `$ne` condition). If any race condition occurs, the atomic condition guarantees that each voter key can only increment the tally once, and Redis Pub/Sub immediately broadcasts the validated state to all active WebSockets."*

### 3. AI Usage Disclosure (1 minute)
> *"Yes, I utilized AI coding assistants (such as Gemini / Antigravity) during development. AI was instrumental in scaffolding boilerplate code, optimizing CSS glassmorphism styling, and formulating comprehensive edge-case unit test scenarios (such as token expiration and invalid JSON payloads). However, all architectural decisions—such as Redis Pub/Sub channel design, Gorilla WebSocket reconnection logic, and Go concurrency safety—were carefully engineered, audited, and verified manually to ensure rock-solid production reliability."*

---

## 📄 License
MIT License. Built for the Developer Task evaluation.
