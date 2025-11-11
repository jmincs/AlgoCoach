// testInterviewMode.mjs
import fetch from 'node-fetch';

async function test() {
  const response = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'explain',
      messages: [
        { role: 'user', content: 'start interview' }
      ],
      interviewer: true,
      topic: 'two pointer',
      autoWorkspace: true
    })
  });

  const text = await response.text();
  console.log(text);
}

test();
