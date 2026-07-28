import { describe, expect, it } from 'vitest';
import { buildExecutionPayload, detectFunction, detectLanguage, smartDefault } from './harness';

describe('harness language detection', () => {
  it('detects java solution classes', () => {
    expect(detectLanguage('class Solution {\n  public List<List<Integer>> threeSum(int[] nums) {\n  }\n}', 'javascript')).toBe('java');
  });

  it('detects python and cpp', () => {
    expect(detectLanguage('def two_sum(nums, target):\n  return []\n', 'javascript')).toBe('python');
    expect(detectLanguage('#include <vector>\nclass Solution {};', 'javascript')).toBe('cpp');
  });
});

describe('harness function detection', () => {
  it('parses nested java generics', () => {
    const code = `class Solution {
    public List<List<Integer>> threeSum(int[] nums) {
        return null;
    }
}`;
    const fn = detectFunction(code, 'java');
    expect(fn?.name).toBe('threeSum');
    expect(fn?.className).toBe('Solution');
    expect(fn?.parameters).toEqual([{ name: 'nums', type: 'int[]' }]);
  });

  it('seeds useful defaults from parameter names', () => {
    expect(smartDefault({ name: 'nums', type: 'int[]' })).toBe('[-1, 0, 1, 2, -1, -4]');
    expect(smartDefault({ name: 'target', type: 'int' })).toBe('0');
  });
});

describe('buildExecutionPayload', () => {
  it('wraps java Solution methods with imports and Main', () => {
    const code = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        return new int[]{0, 1};
    }
}`;
    const fn = detectFunction(code, 'java');
    const payload = buildExecutionPayload('java', code, fn, { nums: '[2, 7, 11, 15]', target: '9' });
    expect(payload).toContain('import java.util.*;');
    expect(payload).toContain('class Main');
    expect(payload).toContain('new Solution().twoSum');
    expect(payload).toContain('new int[]{2, 7, 11, 15}');
    expect(payload).not.toContain('public class');
  });

  it('appends javascript driver when missing', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}';
    const fn = detectFunction(code, 'javascript');
    const payload = buildExecutionPayload('javascript', code, fn, { a: '1', b: '2' });
    expect(payload).toContain('console.log(add(1, 2));');
  });

  it('does not append a driver when the function is already called', () => {
    const code = `function createLeaderboard(data) {
  return data;
}
const getLeaderboard = createLeaderboard(users);
console.log(getLeaderboard);`;
    const fn = detectFunction(code, 'javascript');
    const payload = buildExecutionPayload('javascript', code, fn, { data: ';' });
    expect(payload).toBe(code.trimEnd());
    expect(payload).not.toContain('createLeaderboard(;)');
  });
});
