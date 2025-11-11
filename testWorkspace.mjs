// testWorkspace.mjs
import { workspaceForTopic } from './workspaceTest.mjs';

const topics = [
  'two pointer',
  'sliding window',
  'binary search',
  'hash map',
  'stack',
  'queue',
  'graph bfs',
  'graph dfs',
  'tree bst',
  'dynamic programming',
  'arrays',
  'strings',
  'unknown topic example'
];

for (const topic of topics) {
  console.log(`=== Topic: "${topic}" ===`);
  const ws = workspaceForTopic(topic);
  console.log('Function Name:', ws.functionName);
  console.log('Starter Code:\n', ws.starterCode);
  console.log('Tests:', ws.tests);
  console.log('\n');
}
