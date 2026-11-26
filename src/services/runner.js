// Compiles and runs code from the problem editor on Judge0 (a sandboxed code runner).
// Never compile on this server: an `#include "/proc/self/environ"` would print our secrets in the error output.
//
// LeetCode code is a `class Solution` without a `main`, so before sending it we add what LeetCode adds silently
// (standard headers / imports, ListNode and TreeNode) plus an empty `main` when there is none. Line numbers in
// errors are mapped back to the player's own code.

export const LANGUAGES = {
  cpp: { id: 54, name: 'C++', file: 'main.cpp' },
  java: { id: 62, name: 'Java', file: 'Main.java' },
  python3: { id: 71, name: 'Python 3', file: 'script.py' },
  javascript: { id: 63, name: 'JavaScript', file: 'script.js' },
  kotlin: { id: 78, name: 'Kotlin', file: 'Main.kt' },
};

// Judge0 language ids differ between hosts/versions; JUDGE0_LANGS='{"cpp":105}' overrides them.
try {
  const over = JSON.parse(process.env.JUDGE0_LANGS || '{}');
  for (const [k, id] of Object.entries(over)) if (LANGUAGES[k]) LANGUAGES[k].id = Number(id);
} catch {
  console.warn('[run] JUDGE0_LANGS is not valid JSON; using default language ids');
}

const uses = (code, name) => new RegExp(`\\b${name}\\b`).test(code);
const defines = (code, name) => new RegExp(`\\b(class|struct|function)\\s+${name}\\b`).test(code);
const needs = (code, name) => uses(code, name) && !defines(code, name);

const CPP_NODES = {
  ListNode: 'struct ListNode { int val; ListNode *next; ListNode() : val(0), next(nullptr) {} ListNode(int x) : val(x), next(nullptr) {} ListNode(int x, ListNode *next) : val(x), next(next) {} };',
  TreeNode:
    'struct TreeNode { int val; TreeNode *left; TreeNode *right; TreeNode() : val(0), left(nullptr), right(nullptr) {} TreeNode(int x) : val(x), left(nullptr), right(nullptr) {} TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {} };',
};
const JAVA_NODES = {
  ListNode: 'class ListNode { int val; ListNode next; ListNode() {} ListNode(int val) { this.val = val; } ListNode(int val, ListNode next) { this.val = val; this.next = next; } }',
  TreeNode:
    'class TreeNode { int val; TreeNode left; TreeNode right; TreeNode() {} TreeNode(int val) { this.val = val; } TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; } }',
};
const KOTLIN_NODES = {
  ListNode: 'class ListNode(var `val`: Int) { var next: ListNode? = null }',
  TreeNode: 'class TreeNode(var `val`: Int) { var left: TreeNode? = null; var right: TreeNode? = null }',
};
const PY_NODES = {
  ListNode: 'class ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next',
  TreeNode: 'class TreeNode:\n    def __init__(self, val=0, left=None, right=None):\n        self.val = val\n        self.left = left\n        self.right = right',
};
const JS_NODES = {
  ListNode: 'function ListNode(val, next) { this.val = (val === undefined ? 0 : val); this.next = (next === undefined ? null : next); }',
  TreeNode: 'function TreeNode(val, left, right) { this.val = (val === undefined ? 0 : val); this.left = (left === undefined ? null : left); this.right = (right === undefined ? null : right); }',
};
const nodesFor = (table, code) => Object.keys(table).filter((n) => needs(code, n)).map((n) => table[n]);

/**
 * Returns { source, offset } where `offset` is how many lines were added above the player's code.
 * Additions below the code (helper classes, empty main) do not shift line numbers.
 */
export function wrap(language, code) {
  const join = (before, after) => {
    const head = before.length ? `${before.join('\n')}\n` : '';
    const tail = after.length ? `\n${after.join('\n')}\n` : '\n';
    return { source: head + code + tail, offset: before.length ? head.split('\n').length - 1 : 0 };
  };
  switch (language) {
    case 'cpp':
      return join(['#include <bits/stdc++.h>', 'using namespace std;', ...nodesFor(CPP_NODES, code)], /\bint\s+main\s*\(/.test(code) ? [] : ['int main() { return 0; }']);
    case 'java': {
      // Judge0 runs Main.java: only Main may be public, and Main must have the entry point.
      let body = code.replace(/\bpublic\s+((?:final\s+|abstract\s+)?)class\s+(?!Main\b)/g, '$1class ');
      const after = nodesFor(JAVA_NODES, code);
      const hasMain = /static\s+void\s+main\s*\(/.test(body);
      if (!/\bclass\s+Main\b/.test(body)) {
        if (hasMain) {
          const at = body.search(/static\s+void\s+main\s*\(/);
          const owner = [...body.slice(0, at).matchAll(/\bclass\s+(\w+)/g)].pop()?.[1];
          after.push(`public class Main { public static void main(String[] args) throws Exception { ${owner}.main(args); } }`);
        } else after.push('public class Main { public static void main(String[] args) {} }');
      }
      const imports = ['import java.util.*;', 'import java.util.function.*;', 'import java.util.stream.*;'];
      const out = join(imports, after);
      return { source: out.source.replace(code, () => body), offset: out.offset };
    }
    case 'kotlin':
      return join(['import java.util.*'], [...nodesFor(KOTLIN_NODES, code), ...(/\bfun\s+main\s*\(/.test(code) ? [] : ['fun main() {}'])]);
    case 'python3': {
      // `from __future__` must be first, so any in the player's code becomes a blank line (numbering unchanged).
      const body = code.replace(/^from __future__ import .*$/gm, '');
      const pre = [
        'from __future__ import annotations',
        'from typing import *',
        'import collections, heapq, math, bisect, itertools, functools, string, re, sys',
        'from collections import deque, defaultdict, Counter, OrderedDict',
        'from heapq import heappush, heappop, heapify',
        'from functools import lru_cache, reduce',
        'from math import inf',
        ...nodesFor(PY_NODES, code).join('\n').split('\n').filter(Boolean),
      ];
      const out = join(pre, []);
      return { source: out.source.replace(code, () => body), offset: out.offset };
    }
    case 'javascript':
      return join(nodesFor(JS_NODES, code), []);
    default:
      throw new Error(`Unsupported language ${language}`);
  }
}

const LOCATIONS = {
  cpp: /main\.cpp:(\d+)(?::(\d+))?/g,
  java: /Main\.java:(\d+)/g,
  kotlin: /Main\.kt:(\d+)(?::(\d+))?/g,
  python3: /(File "[^"]*?script\.py", line )(\d+)/g,
  javascript: /script\.js:(\d+)(?::(\d+))?/g,
};

/** Rewrites line numbers in compiler/runtime output to the player's own lines. */
export function mapLines(language, text, offset, userLines) {
  if (!text) return text;
  const fix = (n) => {
    const line = Number(n) - offset;
    return line >= 1 && line <= userLines ? line : null;
  };
  const re = LOCATIONS[language];
  if (language === 'python3') return text.replace(re, (m, pre, n) => (fix(n) ? `${pre}${fix(n)}` : m.replace('script.py', '<template>')));
  return text.replace(re, (m, n, col) => {
    const line = fix(n);
    const file = m.split(':')[0];
    if (!line) return `${file}:<template>`;
    return col ? `${file}:${line}:${col}` : `${file}:${line}`;
  });
}

/** Error locations for underlining in the editor, from already-mapped output. */
export function markersFrom(language, text, userLines) {
  if (!text) return [];
  const out = [];
  const add = (line, column, message) => {
    const l = Number(line);
    if (l >= 1 && l <= userLines && out.length < 20) out.push({ line: l, column: Number(column) || 1, message: message.trim().slice(0, 300) });
  };
  if (language === 'cpp' || language === 'kotlin') {
    for (const m of text.matchAll(/^(?:main\.cpp|Main\.kt):(\d+):(\d+):\s*(?:fatal )?error:\s*(.*)$/gm)) add(m[1], m[2], m[3]);
  } else if (language === 'java') {
    for (const m of text.matchAll(/^Main\.java:(\d+):\s*error:\s*(.*)$/gm)) add(m[1], 1, m[2]);
  } else if (language === 'python3') {
    const lines = [...text.matchAll(/File "[^"]*script\.py", line (\d+)/g)];
    const last = text.trim().split('\n').pop();
    if (lines.length) add(lines[lines.length - 1][1], 1, last);
  } else if (language === 'javascript') {
    const m = text.match(/script\.js:(\d+)/);
    const msg = text.split('\n').find((l) => /^\w*Error\b/.test(l.trim()));
    if (m) add(m[1], 1, msg || 'Error');
  }
  return out;
}

const STATUS = (id) => {
  if (id === 3) return 'ok';
  if (id === 6) return 'compile_error';
  if (id === 5) return 'timeout';
  if (id >= 7 && id <= 12) return 'runtime_error';
  return 'error';
};

const b64 = (s) => Buffer.from(s || '', 'utf8').toString('base64');
const unb64 = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

export function judgeConfig() {
  const url = (process.env.JUDGE0_URL || 'https://judge0-ce.p.rapidapi.com').replace(/\/$/, '');
  const key = process.env.JUDGE0_KEY || '';
  const rapid = /rapidapi\.com/.test(url);
  // A self-hosted Judge0 needs no key; the hosted ones do.
  const configured = !!key || !(rapid || /sulu\.sh/.test(url));
  const headers = { 'Content-Type': 'application/json' };
  if (key && rapid) Object.assign(headers, { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': new URL(url).host });
  else if (key) headers.Authorization = `Bearer ${key}`;
  return { url, headers, configured };
}

export class RunnerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function runCode({ language, code, stdin = '' }) {
  const lang = LANGUAGES[language];
  if (!lang) throw new RunnerError(400, 'Pick C++, Java, Python, JavaScript or Kotlin');
  const { url, headers, configured } = judgeConfig();
  if (!configured) throw new RunnerError(503, "Running code isn't set up on the server yet.");

  const { source, offset } = wrap(language, code);
  const userLines = code.split('\n').length;
  let res;
  try {
    res = await fetch(`${url}/submissions?base64_encoded=true&wait=true&fields=stdout,stderr,compile_output,message,status,time,memory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        language_id: lang.id,
        source_code: b64(source),
        stdin: b64(stdin),
        cpu_time_limit: 3,
        wall_time_limit: 8,
        memory_limit: 256000,
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    throw new RunnerError(502, `The code runner did not respond (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
  }
  if (res.status === 429) throw new RunnerError(429, 'The code runner is busy (rate limit). Try again in a minute.');
  if (res.status === 401 || res.status === 403) throw new RunnerError(503, 'The code runner rejected our API key.');
  if (!res.ok) throw new RunnerError(502, `The code runner responded with ${res.status}.`);
  const r = await res.json();

  const fix = (t) => mapLines(language, unb64(t), offset, userLines);
  const compileOutput = fix(r.compile_output);
  const stderr = fix(r.stderr);
  const status = STATUS(r.status?.id);
  return {
    status,
    label: r.status?.description || 'Unknown',
    stdout: unb64(r.stdout),
    stderr,
    compileOutput,
    message: unb64(r.message),
    time: r.time != null ? Number(r.time) : null,
    memory: r.memory ?? null,
    markers: status === 'compile_error' ? markersFrom(language, compileOutput, userLines) : status === 'runtime_error' ? markersFrom(language, stderr, userLines) : [],
  };
}
