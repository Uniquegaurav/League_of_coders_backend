import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLines, markersFrom, wrap } from '../src/services/runner.js';
import { takeRun } from '../src/routes/run.js';

const CPP = `class Solution {
public:
    bool isSameTree(TreeNode* p, TreeNode* q) {
        return true;
    }
};`;

test('C++: headers, TreeNode and an empty main are added; offset counts added lines', () => {
  const { source, offset } = wrap('cpp', CPP);
  assert.match(source, /#include <bits\/stdc\+\+\.h>/);
  assert.match(source, /struct TreeNode/);
  assert.doesNotMatch(source, /struct ListNode/);
  assert.match(source, /int main\(\) \{ return 0; \}/);
  assert.equal(source.split('\n')[offset], 'class Solution {');
});

test('C++: own main and own TreeNode are kept', () => {
  const code = 'struct TreeNode { int val; };\nint main() { TreeNode t; return 0; }';
  const { source } = wrap('cpp', code);
  assert.equal(source.match(/struct TreeNode/g).length, 1);
  assert.equal(source.match(/int main/g).length, 1);
});

test('Java: public class loses public, Main is added and delegates to a user main', () => {
  const plain = wrap('java', 'public class Solution { int f() { return 1; } }');
  assert.match(plain.source, /\nclass Solution/);
  assert.match(plain.source, /public class Main \{ public static void main\(String\[\] args\) \{\} \}/);
  const withMain = wrap('java', 'class Solution {\n  public static void main(String[] a) { System.out.println(1); }\n}');
  assert.match(withMain.source, /Solution\.main\(args\)/);
  const own = wrap('java', 'public class Main { public static void main(String[] a) {} }');
  assert.equal(own.source.match(/class Main/g).length, 1);
  assert.match(own.source, /public class Main/);
});

test('Java: $ in code survives wrapping', () => {
  const { source } = wrap('java', 'class Solution { String s = "$1 and $&"; }');
  assert.match(source, /"\$1 and \$&"/);
});

test('Kotlin: imports, nodes and main', () => {
  const { source, offset } = wrap('kotlin', 'class Solution {\n  fun f(root: TreeNode?): Int = 0\n}');
  assert.match(source, /^import java\.util\.\*/);
  assert.match(source, /class TreeNode\(var `val`: Int\)/);
  assert.match(source, /fun main\(\) \{\}/);
  assert.equal(source.split('\n')[offset], 'class Solution {');
});

test('Python: future import first, nodes before code, player __future__ blanked', () => {
  const code = 'from __future__ import annotations\nclass Solution:\n    def f(self, root: Optional[TreeNode]) -> List[int]:\n        return []';
  const { source, offset } = wrap('python3', code);
  assert.equal(source.split('\n')[0], 'from __future__ import annotations');
  assert.equal(source.match(/from __future__/g).length, 1);
  assert.match(source, /class TreeNode:/);
  assert.equal(source.split('\n')[offset + 1], 'class Solution:');
});

test('JavaScript: ListNode helper only when used', () => {
  assert.equal(wrap('javascript', 'var f = function() {}').offset, 0);
  const { source, offset } = wrap('javascript', 'var f = function(head) { return new ListNode(1); }');
  assert.equal(offset, 1);
  assert.match(source, /function ListNode/);
});

test('line numbers in errors map back to the player code', () => {
  const out = 'main.cpp:5:9: error: expected \';\'\nmain.cpp:1:1: note: in template';
  const mapped = mapLines('cpp', out, 3, 10);
  assert.match(mapped, /main\.cpp:2:9: error/);
  assert.match(mapped, /main\.cpp:<template>/);
  const py = mapLines('python3', '  File "/box/script.py", line 12, in <module>', 9, 20);
  assert.match(py, /line 3,/);
});

test('markers point at the error lines', () => {
  assert.deepEqual(markersFrom('cpp', "main.cpp:4:12: error: use of undeclared identifier 'x'", 10), [
    { line: 4, column: 12, message: "use of undeclared identifier 'x'" },
  ]);
  assert.equal(markersFrom('java', 'Main.java:2: error: cannot find symbol', 5)[0].line, 2);
  const py = markersFrom('python3', 'Traceback\n  File "script.py", line 3\n    x = \n       ^\nSyntaxError: invalid syntax', 5);
  assert.deepEqual(py, [{ line: 3, column: 1, message: 'SyntaxError: invalid syntax' }]);
});

test('run limits: 6 a minute per player', () => {
  const t = Date.parse('2026-11-27T10:00:00Z');
  for (let i = 0; i < 6; i += 1) takeRun('limit-test', t);
  assert.throws(() => takeRun('limit-test', t), /Too many runs/);
  assert.doesNotThrow(() => takeRun('limit-test', t + 61000));
});
