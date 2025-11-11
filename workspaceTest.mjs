// workspaceTest.mjs
export function pyStub(name, params) {
  const args = params.join(', ');
  return `def ${name}(${args}):
    # TODO: implement
    pass
`;
}

export function workspaceForTopic(rawTopic = '') {
  const t = rawTopic.toLowerCase();

  if (t.includes('two pointer')) {
    return {
      language: 'python',
      functionName: 'is_palindrome',
      params: ['s'],
      starterCode: pyStub('is_palindrome', ['s']),
      tests: [
        { name: 'racecar', args: ['racecar'], expect: true },
        { name: 'abba', args: ['abba'], expect: true },
        { name: 'abc', args: ['abc'], expect: false },
      ],
    };
  }

  if (t.includes('sliding')) {
    return {
      language: 'python',
      functionName: 'max_subarray_sum_of_size_k',
      params: ['arr', 'k'],
      starterCode: pyStub('max_subarray_sum_of_size_k', ['arr', 'k']),
      tests: [
        { name: 'k=2', args: [[1,2,3,4,5], 2], expect: 9 },
        { name: 'k=3', args: [[2,1,5,1,3,2], 3], expect: 9 },
      ],
    };
  }

  if (t.includes('binary search')) {
    return {
      language: 'python',
      functionName: 'binary_search',
      params: ['arr', 'target'],
      starterCode: pyStub('binary_search', ['arr', 'target']),
      tests: [
        { name: 'found', args: [[1,2,3,4], 3], expect: 2 },
        { name: 'not found', args: [[1,2,4,5], 3], expect: -1 },
      ],
    };
  }

  if (t.includes('hash')) {
    return {
      language: 'python',
      functionName: 'two_sum',
      params: ['nums', 'target'],
      starterCode: pyStub('two_sum', ['nums', 'target']),
      tests: [
        { name: 'classic', args: [[2,7,11,15], 9], expect: [0,1] },
        { name: 'another', args: [[3,2,4], 6], expect: [1,2] },
      ],
    };
  }

  if (t.includes('stack') || t.includes('queue')) {
    return {
      language: 'python',
      functionName: 'is_valid_parentheses',
      params: ['s'],
      starterCode: pyStub('is_valid_parentheses', ['s']),
      tests: [
        { name: 'ok', args: ['()[]{}'], expect: true },
        { name: 'bad', args: ['([)]'], expect: false },
        { name: 'nested', args: ['({[]})'], expect: true },
      ],
    };
  }

  if (t.includes('graph') || t.includes('bfs') || t.includes('dfs')) {
    return {
      language: 'python',
      functionName: 'num_islands',
      params: ['grid'],
      starterCode: pyStub('num_islands', ['grid']),
      tests: [
        { name: 'small', args: [[['1','1','0'],['0','1','0'],['0','0','1']]], expect: 2 },
        { name: 'single', args: [[['1']]], expect: 1 },
      ],
    };
  }

  if (t.includes('tree') || t.includes('bst')) {
    return {
      language: 'python',
      functionName: 'sorted_array_to_bst_height',
      params: ['nums'],
      starterCode: pyStub('sorted_array_to_bst_height', ['nums']),
      tests: [
        { name: 'empty', args: [[]], expect: 0 },
        { name: 'len3', args: [[-10,0,5]], expect: 2 },
      ],
    };
  }

  if (t.includes('dynamic')) {
    return {
      language: 'python',
      functionName: 'climb_stairs',
      params: ['n'],
      starterCode: pyStub('climb_stairs', ['n']),
      tests: [
        { name: 'n=1', args: [1], expect: 1 },
        { name: 'n=2', args: [2], expect: 2 },
        { name: 'n=5', args: [5], expect: 8 },
      ],
    };
  }

  // Default: strings/arrays or unknown topics
  return {
    language: 'python',
    functionName: 'length_of_longest_substring',
    params: ['s'],
    starterCode: pyStub('length_of_longest_substring', ['s']),
    tests: [
      { name: 'abcabcbb', args: ['abcabcbb'], expect: 3 },
      { name: 'bbbb', args: ['bbbb'], expect: 1 },
      { name: 'pwwkew', args: ['pwwkew'], expect: 3 },
      { name: 'empty', args: [''], expect: 0 },
    ],
  };
}
