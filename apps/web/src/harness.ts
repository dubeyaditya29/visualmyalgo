import type { Language } from '@visualmyalgo/protocol';

export type FunctionParameter = { name: string; type?: string };
export type FunctionInfo = { name: string; parameters: FunctionParameter[]; line: number; className?: string };

const JAVA_IMPORTS = [
  'import java.util.*;',
  'import java.util.stream.*;',
];

const CPP_INCLUDES = [
  '#include <iostream>',
  '#include <vector>',
  '#include <string>',
  '#include <algorithm>',
  '#include <unordered_map>',
  '#include <unordered_set>',
  '#include <queue>',
  '#include <stack>',
  '#include <climits>',
  'using namespace std;',
];

export function detectLanguage(code: string, current: Language): Language {
  if (/^\s*#include\b|\bstd::|\bvector\s*</m.test(code)) return 'cpp';
  if (/\bpublic\s+class\b|\bSystem\.out\.|\bint\s*\[\s*\]|\bList\s*<|\bHashMap\s*<|\bHashSet\s*</.test(code)) return 'java';
  if (/\b(class\s+\w+|public\s+(?:static\s+)?(?:int|void|String|boolean|List|long))/.test(code) && /[{;]/.test(code) && !/\bfunction\b|\bdef\s+/.test(code)) return 'java';
  if (/^\s*def\s+\w+\s*\(|^\s*(?:from|import)\s+\w+/m.test(code)) return 'python';
  if (/\b(?:const|let|var|function)\b|=>|console\./.test(code)) return 'javascript';
  return current;
}

function splitParameters(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of source) {
    if (char === '<' || char === '[' || char === '(') depth += 1;
    if (char === '>' || char === ']' || char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseParameters(source: string, language: Language): FunctionParameter[] {
  if (!source.trim()) return [];
  return splitParameters(source).map(item => {
    if (language === 'javascript' || language === 'python') {
      const name = item.split(/[=:]/)[0].trim().replace(/^\.\.\./, '');
      return { name, type: item.includes(':') ? item.split(':').slice(1).join(':').trim() : undefined };
    }
    const cleaned = item.replace(/final\s+/g, '').trim();
    const parts = cleaned.split(/\s+/);
    return { name: parts.at(-1)?.replace(/[\[\]]/g, '') || 'value', type: parts.slice(0, -1).join(' ') };
  });
}

function matchBalancedGenerics(typeAndName: string): { type: string; name: string } | undefined {
  const trimmed = typeAndName.trim();
  const nameMatch = /\b([A-Za-z_]\w*)\s*$/.exec(trimmed);
  if (!nameMatch) return undefined;
  const name = nameMatch[1];
  const type = trimmed.slice(0, nameMatch.index).trim();
  if (!type) return undefined;
  return { type, name };
}

export function detectFunction(code: string, language: Language): FunctionInfo | undefined {
  if (language === 'javascript') {
    const patterns = [/function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/, /(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\(([^)]*)\)\s*=>/];
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      if (match && match[1] !== 'main') {
        return { name: match[1], parameters: parseParameters(match[2], language), line: code.slice(0, match.index).split('\n').length };
      }
    }
  }

  if (language === 'python') {
    const match = /def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/.exec(code);
    if (match && match[1] !== 'main') {
      return { name: match[1], parameters: parseParameters(match[2], language), line: code.slice(0, match.index).split('\n').length };
    }
  }

  if (language === 'java') {
    const className = /\bclass\s+([A-Za-z_]\w*)/.exec(code)?.[1];
    const method = /(?:public|private|protected)\s+(?:static\s+)?(.+?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/s.exec(code);
    if (method && method[2] !== 'main') {
      const returnType = method[1].trim();
      if (!/^(if|for|while|switch)$/.test(method[2]) && !/[=;]/.test(returnType)) {
        return {
          name: method[2],
          parameters: parseParameters(method[3], language),
          line: code.slice(0, method.index).split('\n').length,
          className,
        };
      }
    }
    // Fallback without requiring `{` on same match (multiline signatures)
    const loose = /(?:public|private|protected)\s+(?:static\s+)?([\w.<>,\[\]\s]+?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(code);
    if (loose && loose[2] !== 'main') {
      return {
        name: loose[2],
        parameters: parseParameters(loose[3], language),
        line: code.slice(0, loose.index).split('\n').length,
        className,
      };
    }
  }

  if (language === 'cpp') {
    const className = /\bclass\s+([A-Za-z_]\w*)/.exec(code)?.[1];
    const match = /(?:^|\n)\s*(?:[\w:<>,&\s\*]+)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/.exec(code);
    if (match && match[1] !== 'main' && !['if', 'for', 'while', 'switch'].includes(match[1])) {
      return {
        name: match[1],
        parameters: parseParameters(match[2], language),
        line: code.slice(0, match.index).split('\n').length,
        className,
      };
    }
  }

  return undefined;
}

export function defaultArgument(parameter: FunctionParameter) {
  const type = parameter.type || '';
  if (/string|String/.test(type) && !/\[|List|vector|Set|Map/.test(type)) return '"a"';
  if (/bool|boolean|Boolean/.test(type)) return 'false';
  if (/\[|List|vector|Set|array/i.test(type)) return '[]';
  if (/Map|dict|object/i.test(type)) return '{}';
  return '0';
}

export function smartDefault(parameter: FunctionParameter) {
  const name = parameter.name.toLowerCase();
  const type = parameter.type || '';

  if (['nums', 'numbers'].includes(name)) return '[-1, 0, 1, 2, -1, -4]';
  if (['values', 'arr', 'array', 'list', 'height', 'prices'].includes(name)) return '[3, 8, 13, 21, 34]';
  if (['matrix', 'grid', 'board'].includes(name)) return '[[1, 2], [3, 4]]';
  if (['target', 'k', 'key', 'needle', 'sum'].includes(name)) return '0';
  if (['s', 'str', 'word', 'text', 'pattern'].includes(name)) return '"abc"';
  if (name === 'n' || name === 'm') return '3';
  if (/string|String/.test(type) && !/\[|List|vector/.test(type)) return '"abc"';
  if (/bool|boolean|Boolean/.test(type)) return 'false';
  if (/int\s*\[\]|vector\s*<\s*int\s*>|List\s*<\s*Integer\s*>/.test(type)) return '[1, 2, 3, 4, 5]';
  return defaultArgument(parameter);
}

function ensureJavaImports(code: string) {
  const missing = JAVA_IMPORTS.filter(line => {
    if (line.includes('stream')) return !/\bimport\s+java\.util\.stream\./.test(code);
    return !/\bimport\s+java\.util\.\*|\bimport\s+java\.util\.[A-Z]/.test(code);
  });
  if (!missing.length) return code;
  return `${missing.join('\n')}\n\n${code}`;
}

function ensureCppIncludes(code: string) {
  if (/^\s*#include\b/m.test(code)) return code;
  return `${CPP_INCLUDES.join('\n')}\n\n${code}`;
}

function stripPublicClass(code: string) {
  return code.replace(/\bpublic\s+class\b/g, 'class');
}

function javaLiteral(value: string, type = '') {
  const input = value.trim() || defaultArgument({ name: '', type });
  const normalizedType = type.replace(/\s/g, '');

  if (/^String$/.test(normalizedType) || normalizedType === 'string') {
    if (input.startsWith('"') || input.startsWith("'")) return input.replace(/^'/, '"').replace(/'$/, '"');
    return JSON.stringify(input.replace(/^["']|["']$/g, ''));
  }

  if (/boolean|Boolean/.test(normalizedType)) return input === 'true' ? 'true' : 'false';

  if (/int\[\]|long\[\]|double\[\]/.test(normalizedType) && input.startsWith('[')) {
    return `new ${normalizedType}{${input.slice(1, -1)}}`;
  }

  if (/String\[\]/.test(normalizedType) && input.startsWith('[')) {
    const items = input.slice(1, -1).split(',').map(item => {
      const trimmed = item.trim();
      if (!trimmed) return '""';
      if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed.replace(/^'/, '"').replace(/'$/, '"');
      return JSON.stringify(trimmed);
    });
    return `new String[]{${items.join(', ')}}`;
  }

  if (/List<List<Integer>>|List<\s*List\s*<\s*Integer\s*>\s*>/.test(type) && input.startsWith('[')) {
    return javaNestedIntList(input);
  }

  if (/List<\s*Integer\s*>/.test(type) && input.startsWith('[')) {
    return `java.util.Arrays.asList(${input.slice(1, -1)})`;
  }

  if (/List<\s*String\s*>/.test(type) && input.startsWith('[')) {
    const items = input.slice(1, -1).split(',').map(item => JSON.stringify(item.trim().replace(/^["']|["']$/g, '')));
    return `java.util.Arrays.asList(${items.join(', ')})`;
  }

  if (input.startsWith('[') && /\[\]|List|vector/i.test(type)) {
    return `new int[]{${input.slice(1, -1)}}`;
  }

  return input;
}

function javaNestedIntList(input: string) {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return 'java.util.List.of()';
    const rows = parsed.map(row => {
      if (!Array.isArray(row)) return 'java.util.List.of()';
      return `java.util.Arrays.asList(${row.join(', ')})`;
    });
    return `java.util.Arrays.asList(${rows.join(', ')})`;
  } catch {
    return 'java.util.List.of()';
  }
}

function cppLiteral(value: string, type = '') {
  const input = value.trim() || defaultArgument({ name: '', type });
  if (/vector\s*<\s*int\s*>/.test(type) && input.startsWith('[')) return `{${input.slice(1, -1)}}`;
  if (/string|string/.test(type) && !input.startsWith('"')) return JSON.stringify(input.replace(/^["']|["']$/g, ''));
  if (input.startsWith('[') && /vector/.test(type)) return `{${input.slice(1, -1)}}`;
  return input;
}

function pythonLiteral(value: string) {
  return value.trim() || 'None';
}

function codeAlreadyInvokes(code: string, name: string, language: Language) {
  // Strip the definition signature so we only detect real call sites (e.g. createLeaderboard(users)).
  let remainder = code;
  if (language === 'javascript') {
    remainder = remainder
      .replace(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)`, 'g'), '')
      .replace(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`, 'g'), '');
  } else if (language === 'python') {
    remainder = remainder.replace(new RegExp(`def\\s+${name}\\s*\\([^)]*\\)`, 'g'), '');
  }
  return new RegExp(`\\b${name}\\s*\\(`).test(remainder);
}

function javaPrintResult(expression: string) {
  return [
    `Object result = ${expression};`,
    'if (result == null) System.out.println("null");',
    'else if (result instanceof int[]) System.out.println(java.util.Arrays.toString((int[]) result));',
    'else if (result instanceof long[]) System.out.println(java.util.Arrays.toString((long[]) result));',
    'else if (result instanceof double[]) System.out.println(java.util.Arrays.toString((double[]) result));',
    'else if (result instanceof Object[]) System.out.println(java.util.Arrays.deepToString((Object[]) result));',
    'else System.out.println(result);',
  ].join(' ');
}

/**
 * Build a runnable program from editor code + parameter inputs.
 * Generic for LeetCode-style Solution classes and plain functions — not problem-specific.
 */
export function buildExecutionPayload(language: Language, code: string, fn: FunctionInfo | undefined, inputs: Record<string, string>) {
  const source = code.replace(/\s+$/, '');

  if (!fn) {
    if (language === 'java') return ensureJavaImports(stripPublicClass(source));
    if (language === 'cpp') return ensureCppIncludes(source);
    return source;
  }

  const values = fn.parameters.map(parameter => inputs[parameter.name] ?? smartDefault(parameter));

  if (language === 'javascript') {
    if (!fn.parameters.length || codeAlreadyInvokes(source, fn.name, language)) return source;
    return `${source}\n\nconsole.log(${fn.name}(${values.join(', ')}));`;
  }

  if (language === 'python') {
    if (!fn.parameters.length || codeAlreadyInvokes(source, fn.name, language)) return source;
    return `${source}\n\nprint(${fn.name}(${values.map(pythonLiteral).join(', ')}))`;
  }

  if (language === 'java') {
    let body = ensureJavaImports(stripPublicClass(source));
    if (/static\s+void\s+main\s*\(/.test(body)) return body;

    const className = fn.className || /\bclass\s+([A-Za-z_]\w*)/.exec(body)?.[1] || 'Solution';
    const args = fn.parameters.map((parameter, index) => javaLiteral(values[index], parameter.type)).join(', ');
    const call = `new ${className}().${fn.name}(${args})`;
    return `${body}\n\nclass Main {\n  public static void main(String[] args) {\n    ${javaPrintResult(call)}\n  }\n}\n`;
  }

  if (language === 'cpp') {
    let body = ensureCppIncludes(source);
    if (/\bint\s+main\s*\(/.test(body)) return body;
    const className = fn.className || /\bclass\s+([A-Za-z_]\w*)/.exec(body)?.[1] || 'Solution';
    const args = fn.parameters.map((parameter, index) => cppLiteral(values[index], parameter.type)).join(', ');
    return `${body}\n\nint main() {\n  auto result = ${className}().${fn.name}(${args});\n  cout << "ok" << endl;\n  return 0;\n}\n`;
  }

  return source;
}

export function languageNeedsDocker(language: Language) {
  return language !== 'javascript';
}

/** Exported for tests — validates balanced-type helper stays available. */
export const __test = { matchBalancedGenerics, splitParameters, javaLiteral };
