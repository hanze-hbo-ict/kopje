import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectManager } from '../../src/project/ProjectManager.ts';
import { SessionStore } from '../../src/project/SessionStorage.ts';
import { templateProject, newFileSource } from '../../src/project/model.ts';

class MemoryStorage {
  constructor() { this.m = new Map(); this.fail = false; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.fail) throw new DOMException('quota', 'QuotaExceededError'); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

test('template is a two-file package project with example.Main', () => {
  const pm = new ProjectManager(templateProject());
  assert.deepEqual(pm.paths, ['example/Calculator.java', 'example/Main.java']);
  assert.equal(pm.mainClass, 'example.Main');
  assert.deepEqual(pm.mainCandidates().map((m) => m.className), ['example.Main'], 'Calculator has no main');
});

test('create derives the package from the folder and rejects collisions', () => {
  const pm = new ProjectManager(templateProject());
  assert.equal(pm.createFile('util/text/Words.java'), 'util/text/Words.java');
  assert.equal(pm.source('util/text/Words.java'), 'package util.text;\n\npublic class Words {\n\n}\n');
  assert.equal(pm.activeFile, 'util/text/Words.java');
  assert.throws(() => pm.createFile('example/main.java'), /already exists/);
  assert.throws(() => pm.createFile('../x.java'));
  assert.equal(newFileSource('Top.java'), 'public class Top {\n\n}\n');
});

test('rename keeps content, follows main class and active file', () => {
  const pm = new ProjectManager(templateProject());
  const before = pm.source('example/Main.java');
  pm.renameFile('example/Main.java', 'app/Start.java');
  assert.equal(pm.source('app/Start.java'), before, 'no refactoring');
  assert.equal(pm.mainClass, 'example.Main', 'class names come from the source, which rename does not change');
  assert.equal(pm.activeFile, 'app/Start.java');
  assert.throws(() => pm.renameFile('app/Start.java', 'example/Calculator.java'), /already exists/);
  assert.equal(pm.renameFile('app/Start.java', 'app/Start.java'), 'app/Start.java');
});

test('delete picks a new main class and keeps at least one file', () => {
  const pm = new ProjectManager(templateProject());
  pm.deleteFile('example/Main.java');
  assert.equal(pm.mainClass, '', 'no class left with a main method');
  assert.equal(pm.activeFile, 'example/Calculator.java');
  assert.throws(() => pm.deleteFile('example/Calculator.java'), /at least one/);
});

test('session store round-trips project and theme', () => {
  const storage = new MemoryStorage();
  const s = new SessionStore(storage);
  const p = templateProject();
  p.files['x/Y.java'] = 'class Y {}';
  p.activeFile = 'x/Y.java';
  s.save(p, { theme: 'dark' }, true);
  const back = new SessionStore(storage).load();
  assert.deepEqual({ ...back.project.files }, p.files); // stored map is null-prototype by design
  assert.equal(back.project.activeFile, 'x/Y.java');
  assert.equal(back.ui.theme, 'dark');
});

test('session store rejects corrupt or unsafe data and survives quota errors', () => {
  const storage = new MemoryStorage();
  storage.setItem('kopje:session:v1', '{not json');
  assert.equal(new SessionStore(storage).load(), null);
  storage.setItem('kopje:session:v1', JSON.stringify({ v: 1, project: { files: { '../evil.java': '' }, mainClass: 'x', activeFile: '' }, ui: {} }));
  assert.equal(new SessionStore(storage).load(), null);
  storage.setItem('kopje:session:v1', JSON.stringify({ v: 1, project: { files: { 'A.java': '' }, mainClass: 'bad name', activeFile: 'nope' }, ui: { theme: 'neon' } }));
  const r = new SessionStore(storage).load();
  assert.equal(r.project.activeFile, 'A.java');
  assert.equal(r.project.mainClass, '');
  assert.equal(r.ui.theme, 'system');
  storage.fail = true;
  const s = new SessionStore(storage);
  s.save(templateProject(), { theme: 'system' }, true);
  assert.equal(s.persistent, false);
});

test('session store without storage works in memory', () => {
  const s = new SessionStore(null);
  assert.equal(s.load(), null);
  assert.equal(s.persistent, false);
  s.save(templateProject(), { theme: 'light' }, true);
});

test('replaceAll, addFiles, reset, isModified', () => {
  const pm = new ProjectManager(templateProject());
  assert.equal(pm.isModified(), false);
  assert.equal(pm.differsFromTemplate(), false);
  pm.replaceAll({ 'q/Helper.java': 'package q; class Helper {}', 'q/App.java': 'package q; public class App { public static void main(String[] a) {} }' });
  assert.deepEqual(pm.paths, ['q/App.java', 'q/Helper.java']);
  assert.equal(pm.mainClass, 'q.App');
  assert.equal(pm.activeFile, 'q/App.java');
  assert.equal(pm.isModified(), false, 'a full import is the new baseline');
  assert.equal(pm.differsFromTemplate(), true);
  pm.setContent('q/App.java', 'package q; public class App { public static void main(String[] a) { int edited; } }');
  assert.deepEqual(pm.addFiles({ 'q/Helper.java': 'package q; class Helper { int x; }', 'q/New.java': '' }), ['q/Helper.java']);
  assert.equal(pm.source('q/Helper.java'), 'package q; class Helper { int x; }');
  assert.equal(pm.isModified(), true, 'the edit to App is not part of the baseline');
  assert.throws(() => pm.addFiles({ '../x.java': '' }));
  assert.throws(() => pm.replaceAll({}), /empty/);
  pm.setArgs('a b');
  pm.reset();
  assert.equal(pm.isModified(), false);
  assert.deepEqual(pm.paths, ['q/App.java', 'q/Helper.java', 'q/New.java'], 'added files are kept by Reset');
  assert.equal(pm.source('q/App.java'), 'package q; public class App { public static void main(String[] a) {} }');
  assert.equal(pm.source('q/Helper.java'), 'package q; class Helper { int x; }');
  assert.equal(pm.mainClass, 'q.App');
  assert.equal(pm.args, '');

  const fresh = new ProjectManager(templateProject());
  fresh.deleteFile('example/Calculator.java');
  fresh.reset();
  assert.equal(fresh.differsFromTemplate(), false);
  assert.equal(fresh.mainClass, 'example.Main');
});

test('the baseline is stored with the project', () => {
  const storage = new MemoryStorage();
  const pm = new ProjectManager(templateProject());
  pm.replaceAll({ 'A.java': 'public class A { public static void main(String[] a) {} }' });
  pm.setContent('A.java', 'public class A { public static void main(String[] a) { int x; } }');
  new SessionStore(storage).save(pm.snapshot(), { theme: 'system' }, true);
  const back = new ProjectManager(new SessionStore(storage).load().project);
  assert.equal(back.isModified(), true);
  back.reset();
  assert.equal(back.source('A.java'), 'public class A { public static void main(String[] a) {} }');
});

test('session store clear removes stored state', () => {
  const storage = new MemoryStorage();
  const s = new SessionStore(storage);
  s.save(templateProject(), { theme: 'dark' }, true);
  s.clear();
  assert.equal(new SessionStore(storage).load(), null);
});

test('main class follows edits: appears, is renamed in source, survives half-typed edits', () => {
  const pm = new ProjectManager(templateProject());
  pm.deleteFile('example/Main.java');
  assert.equal(pm.mainClass, '');
  const calc = 'package example;\n\npublic class Calculator {\n    public static void main(String[] args) {}\n}\n';
  pm.setContent('example/Calculator.java', calc);
  assert.equal(pm.mainClass, 'example.Calculator', 'first main is selected');
  pm.setContent('example/Calculator.java', calc.replace('class Calculator', 'class Calc'));
  assert.equal(pm.mainClass, 'example.Calc', 'renamed class is followed');
  pm.setContent('example/Calculator.java', calc.replace('class Calculator', 'class Calc').replace('String[] args', 'String[] '));
  assert.equal(pm.mainClass, 'example.Calc', 'selection stays while main is broken');
  assert.equal(pm.mainCandidates().length, 0);
  pm.setContent('example/Calculator.java', '');
  pm.setContent('example/Calculator.java', calc.replace('class Calculator', 'class Sum'));
  assert.equal(pm.mainClass, 'example.Sum', 'followed even after the file was emptied');
});

test('args are stored with the project and capped', () => {
  const storage = new MemoryStorage();
  const pm = new ProjectManager(templateProject());
  pm.setArgs('3 "two words"');
  const s = new SessionStore(storage);
  s.save(pm.snapshot(), { theme: 'system' }, true);
  assert.equal(new SessionStore(storage).load().project.args, '3 "two words"');
  pm.setArgs('x'.repeat(5000));
  assert.equal(pm.args.length, 1000);
  pm.reset();
  assert.equal(pm.args, '');
});
