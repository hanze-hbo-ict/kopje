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
  assert.equal(pm.mainCandidates()[0].className, 'example.Main');
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
  assert.equal(pm.mainClass, 'app.Start');
  assert.equal(pm.activeFile, 'app/Start.java');
  assert.throws(() => pm.renameFile('app/Start.java', 'example/Calculator.java'), /already exists/);
  assert.equal(pm.renameFile('app/Start.java', 'app/Start.java'), 'app/Start.java');
});

test('delete picks a new main class and keeps at least one file', () => {
  const pm = new ProjectManager(templateProject());
  pm.deleteFile('example/Main.java');
  assert.equal(pm.mainClass, 'example.Calculator');
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
  storage.setItem('javaedit:session:v1', '{not json');
  assert.equal(new SessionStore(storage).load(), null);
  storage.setItem('javaedit:session:v1', JSON.stringify({ v: 1, project: { files: { '../evil.java': '' }, mainClass: 'x', activeFile: '' }, ui: {} }));
  assert.equal(new SessionStore(storage).load(), null);
  storage.setItem('javaedit:session:v1', JSON.stringify({ v: 1, project: { files: { 'A.java': '' }, mainClass: 'bad name', activeFile: 'nope' }, ui: { theme: 'neon' } }));
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
