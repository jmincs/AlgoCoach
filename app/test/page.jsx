'use client'

import { useEffect, useState } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import LogoutButton from '../components/LogoutButton'; // ✅ import the button

export default function TestPage() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold mb-4">🚀 Firebase Firestore Test</h1>
      
      {/* ✅ Insert logout button here */}
      <LogoutButton />

      {loading ? (
        <p>Loading...</p>
      ) : (
        <ul className="list-disc list-inside">
          {messages.map((msg, idx) => (
            <li key={idx}>{msg}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
