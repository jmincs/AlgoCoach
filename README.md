<div align="center">

# AlgoCoach — RAG Mock Interview Coach 🤖
</div>

<div align="center">

  <br />

  [![Next.js](https://img.shields.io/badge/Next.js-15.4.5-black?style=for-the-badge&logo=nextdotjs)](https://nextjs.org/)
  [![LangChain](https://img.shields.io/badge/LangChain-RAG-purple?style=for-the-badge)](https://www.langchain.com/)
  [![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4-blue?style=for-the-badge&logo=openai)](https://platform.openai.com/)
  [![Firebase](https://img.shields.io/badge/Firebase-12.0.0-orange?style=for-the-badge&logo=firebase)](https://firebase.google.com/)
  [![Docker](https://img.shields.io/badge/Docker-25.0-2496ED?style=for-the-badge&logo=docker)](https://www.docker.com/)

  <p align="center">
    <strong>🎯 Customized Training</strong> • <strong>🧠 RAG-Guided Problem Recommendations</strong> • <strong>🧪 Sandbox Coding Workspace</strong>
  </p>
</div>

---

## 🎯 Overview

Context-based DS&A practice environment, pairing a personalized AI interviewer with a fully sandboxed coding workspace that can simulate whiteboard interviews, debug code, and give explanations.

---

## ✨ Key Features

### 🤖 AI Interview Coach
- Topic-aware problem selection (arrays, graphs, DP, etc.).
- Adaptive follow-up questions and walk-throughs.
- RAG hints sourced from curated algorithmic notes.

### 🧪 Remote Python Workspace
- Auto-generated starter code, parameters, tests, and canonical solution.
- Executes via a dedicated runner microservice that shells into warm `judge-python` containers.
- Captures stdout/stderr, compares your output to the reference, and shows per-case diffs.
- Dedicated stdout panel + per-test stdout snippets for quick inspection.

### 🛠 Supporting Assistant Tools
- Ask for complexity, examples, or clarifications during the interview session.
- Markdown + KaTeX rendering for math-heavy derivations.

---

## 🛠 Technical Architecture

```
Client (Next.js App Router)
  ├─ /api/chat    → OpenAI + LangChain (interview orchestration)
  └─ /api/runner  → runner-service proxy → warm docker exec → run_submission.py

runner-service (Express)
  ├─ Validates requests with Zod
  ├─ Worker queue + pool (N warm containers)
  └─ Streams results back to /api/runner
```

- **Frontend**: React + Tailwind CSS with streaming responses via `ReadableStream`.
- **Backend**: `/api/chat` handles prompt construction, single-problem guard logic, and RAG context injection.
- **Sandbox**: `/api/runner` proxies to `runner-service`, which manages a warm Docker worker pool (no per-request container spin-up).
- **RAG Store**: Lightweight LangChain vector store to personalize practice for each user.

---

## 🧭 How Sessions Work

1. **Start interview** — choose a topic and receive a single NeetCode problem.
2. **Discuss and code** — brainstorm with the interviewer, request hints/examples, edit Python starter code.
3. **Run custom input** — enter arguments line-by-line, click **Run Custom Input**, and inspect stdout + comparisons.
4. **End interview** — clears chat/workspace so you can begin another session.

---

## ⚙️ Development Setup

```bash
# Install frontend/API deps
npm install

# Build sandbox image once
cd runner/python
docker build -t judge-python .
cd ../../

# Install runner microservice deps
cd runner-service
npm install
cd ..

# Configure environment secrets
.env.local:
# Authentication
OPENAI_API_KEY=your_open_ai_key

# Firebase configurations
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id

# Runner service URL
RUNNER_SERVICE_URL=http://127.0.0.1:4001/run

# Start services (in separate terminals)
npm run dev                 # Next.js app
cd runner-service && npm run dev   # Express runner
```

Visit [http://localhost:3000](http://localhost:3000) to launch AlgoCoach once both processes are up.

### 🚀 Deploying runner-service

Build and run the microservice as a container (requires mounting the host Docker socket so it can launch sandboxes):

```bash
cd runner-service
docker build -t algo-runner-service .

docker run -d \
  --name algo-runner-service \
  -p 4001:4001 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e RUNNER_POOL_SIZE=4 \
  algo-runner-service
```

> Tip: pass additional `-e` flags (e.g., `RUNNER_IMAGE`, `RUNNER_CONTAINER_PREFIX`, `DOCKER_BINARY`) to customize the worker fleet.

Point the Next.js app at the deployed service:

```
RUNNER_SERVICE_URL=http://<host>:4001/run
```

### ♨️ runner-service microservice

- Located in `runner-service/`, powered by Express + Zod. It exposes `/run` (execution) and `/healthz` (status).
- Spawns a configurable pool of warm Docker containers (`RUNNER_POOL_SIZE`, default 2) named `${RUNNER_CONTAINER_PREFIX}-N` and queues jobs so no request ever pays the cold-start penalty.
- Key environment variables (can be placed in `runner-service/.env`):

  ```
  RUNNER_SERVICE_PORT=4001
  RUNNER_POOL_SIZE=10    # Match or exceed expected concurrent load
  RUNNER_IMAGE=judge-python
  RUNNER_CONTAINER_PREFIX=judge-python-worker
  RUNNER_EXEC_TIMEOUT_MS=60000
  # DOCKER_BINARY=/opt/homebrew/bin/docker   # override if needed
  ```

- Restarting the service automatically rehydrates the worker pool. To fully reset, run `docker rm -f judge-python-worker-*`.
- `/metrics` surfaces queue depth, active workers, historical latency, and process memory stats for monitoring/alerting.

---

## 🤝 Contributing

Contributions are welcome. Please fork the repo, open an issue, or submit a pull request.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

