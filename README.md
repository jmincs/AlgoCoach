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
- Executes inside the `judge-python` Docker container—no Pyodide hacks.
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
  └─ /api/runner  → docker run judge-python → run_submission.py → JSON response
```

- **Frontend**: React + Tailwind CSS with streaming responses via `ReadableStream`.
- **Backend**: `/api/chat` handles prompt construction, single-problem guard logic, and RAG context injection.
- **Sandbox**: `/api/runner` validates payloads and runs user/reference solutions inside Docker.
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
# Install dependencies
npm install

# Build sandbox image
cd runner/python
docker build -t judge-python .
cd ../../

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

# Run server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) to launch AlgoCoach.

---

## 🤝 Contributing

Contributions are welcome. Please fork the repo, open an issue, or submit a pull request.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

