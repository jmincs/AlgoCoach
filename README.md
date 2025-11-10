# AlgoCoach - Your Personal Coding Mentor & Interview Coach

AlgoCoach Interface  
Next.js • LangChain • OpenAI • Tailwind CSS

Real-Time Code Help • AI Interviewer • Complexity Analysis • Debugging Assistance

---

## Overview
AlgoCoach is an intelligent coding mentor and mock interviewing platform designed to help you understand algorithms, debug code, and practice technical interviews.  
With streaming AI responses, interactive modes, and simulated interviews, AlgoCoach adapts to your needs—whether you’re learning, troubleshooting, or preparing for your next interview.

---

## Key Features

### AI-Powered Coding Assistant
- Explain code step by step (`explain` mode)  
- Find and fix bugs (`debug` mode)  
- Improve readability and efficiency (`refactor` mode)  
- Analyze time and space complexity (`complexity` mode)  
- Support for multiple programming languages  

### Mock Interview Simulator
- Realistic interview conversations with dynamic follow-ups  
- Topic-based practice (arrays, graphs, dynamic programming, etc.)  
- Progressive difficulty adjustment based on responses  
- Real-time hints and guidance  

### Learning Tools
- Lightweight RAG (Retrieval-Augmented Generation) knowledge base  
- Semantic context retrieval powered by LangChain embeddings  
- Interactive chat interface styled like Discord/Messages  
- Markdown + Math + KaTeX rendering for rich explanations  

---

## Technical Architecture

### Frontend
- Framework: Next.js (App Router)  
- UI: React + Tailwind CSS  
- Streaming: Fetch API + ReadableStream for live AI responses  
- Markdown Rendering: React-Markdown with GFM & Math plugins  

### Backend
- API Routes: Next.js API handlers (`/api/chat`)  
- AI Integration: OpenAI API  
- Embeddings: LangChain + OpenAIEmbeddings  
- Vector Store: In-memory RAG-lite system  

---

## How It Works

1. Select Mode  
   Choose from explain, debug, refactor, complexity, or interview.  

2. Ask a Question or Paste Code  
   The AI analyzes your input and begins streaming a response.  

3. Interactive Feedback  
   AlgoCoach adapts explanations and interview questions based on your interaction.  

4. Practice and Refine  
   Continue the conversation, refine solutions, or simulate a full interview.  

---

## Performance and Reliability
- Real-time streaming responses (sub-2 second latency)  
- Handles code snippets up to 20k characters  
- Session memory with up to 12 exchanges  
- Lightweight design—no heavy database required  

---

## Development Setup

Clone the repository:
    
    git clone https://github.com/your-username/algocoach.git
    cd algocoach

Install dependencies:
    
    npm install
    # or
    yarn install

Run development server:
    
    npm run dev

Open [http://localhost:3000](http://localhost:3000).

---

## Contributing
Contributions are welcome. Please fork the repo, open an issue, or submit a pull request.

---

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
