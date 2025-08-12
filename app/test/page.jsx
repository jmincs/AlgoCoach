'use client';

import { useEffect, useState } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import LogoutButton from '../components/LogoutButton';

export default function TestPage() {
  // Firestore test state
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  // API chat test state
  const [question, setQuestion] = useState('Explain sliding window vs two pointers.');
  const [code, setCode] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    async function fetchData() {
      const querySnapshot = await getDocs(collection(db, 'test'));
      const msgs = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        if (data.message) msgs.push(data.message);
      });
      setMessages(msgs);
      setLoading(false);
    }

    fetchData();
  }, []);

  async function askCodeBuddy(e) {
    e.preventDefault();
    setAiAnswer('');
    setAiLoading(true);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'explain',
        messages: [{ role: 'user', content: question }],
        code,
      }),
    });

    if (!res.ok || !res.body) {
      setAiAnswer(`Request failed: ${res.status}`);
      setAiLoading(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setAiAnswer((prev) => prev + decoder.decode(value));
      }
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-8">
      <h1 className="text-xl font-bold">🚀 Firebase Firestore Test</h1>

      {/* Logout button */}
      <LogoutButton />

      {loading ? (
        <p>Loading Firestore messages...</p>
      ) : (
        <ul className="list-disc list-inside">
          {messages.map((msg, idx) => (
            <li key={idx}>{msg}</li>
          ))}
        </ul>
      )}

      <hr className="my-6" />

      {/* CodeBuddy AI Test */}
      <h2 className="text-lg font-bold">🤖 CodeBuddy Test</h2>

      <form onSubmit={askCodeBuddy} className="space-y-3">
        <input
          className="w-full border rounded p-2"
          placeholder="Ask your question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          required
        />
        <textarea
          className="w-full border rounded p-2 font-mono h-32"
          placeholder="// Optional: paste code here"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-60"
          type="submit"
          disabled={aiLoading}
        >
          {aiLoading ? 'Thinking…' : 'Ask CodeBuddy'}
        </button>
      </form>

      <div className="border rounded p-3 whitespace-pre-wrap min-h-[120px]">
        {aiAnswer || (aiLoading ? 'Waiting for response…' : 'Response will appear here')}
      </div>
    </div>
  );
}
