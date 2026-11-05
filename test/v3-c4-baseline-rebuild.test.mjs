import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachV3Engine } from '../src/v3/entry/v3-entry.mjs'
import { createFakeSession } from './helpers/fake-session.mjs'
import { sessionStatePath, writeSessionState } from '../src/v3/adapters/storage/session-state.mjs'
import { sessionControlPath, writeSessionControl } from '../src/v3/adapters/storage/session-control.mjs'
import { emptySessionState, patchSessionState } from '../src/v3/domain/session/mode.mjs'
import { emptySessionControl, patchSessionControl } from '../src/v3/domain/session/session-control.mjs'

const SESSION_ID = 'session-fake'
const CONFIG = { enabled: true, minGrowthMessages: 2, minRequestGap: 2, maxRequestGap: 40, backlogCoalesceUnits: 200 }
const SETTINGS = { retainOperations: 1, coolingBatchSize: 3, coolingGate: 0, schedulePolicyConfig: CONFIG }
// 第二次归档用：不带 schedulePolicyConfig。策略关掉后节奏门不参与，第二次归档才能真的走到 setState 写盘。
const SETTINGS_NO_POLICY = { retainOperations: 1, coolingBatchSize: 3, coolingGate: 0 }
function growSteps(session, from, to) { for (let i = from; i <= to; i++) { session.append('step/start', { turn: 1, step: i }); session.pushAssistant(('第二次归档正文第' + i + '步 ').repeat(120)); session.append('step/end', { turn: 1, step: i }) } }
function context() { const handlers=new Map(); return { on(n,h){handlers.set(n,h);return()=>handlers.delete(n)}, logger:{warn(){},info(){}}, async step(session,step){const h=handlers.get('agent/pre-step');return h({agent:{session},turn:1,step,signal:undefined},async()=>({kind:'enter'}))} } }
function seed(session){session.pushContextWindow(1000000);session.pushUser('起始'); for(let i=1;i<=6;i++){session.append('step/start',{turn:1,step:i});session.pushAssistant(('测试正文第'+i+'步 ').repeat(120));session.append('step/end',{turn:1,step:i})}}
async function settle(engine){await new Promise(r=>setTimeout(r,150));await engine._waitForIdle().catch(()=>{});await new Promise(r=>setTimeout(r,40))}
async function prep(root){const dir=path.join(root,'sessions',SESSION_ID);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'usage.jsonl'),JSON.stringify({seq:1,inputTokens:300000,totalTokens:300001})+'\n')}
async function fixture(fn){const root=await mkdtemp(path.join(tmpdir(),'mcl-c4-rebuild-'));let engine;try{return await fn({root,make(){const ctx=context();engine=attachV3Engine(ctx,{v3Root:root});return{ctx,engine}}})}finally{if(engine){await engine._waitForIdle().catch(()=>{});await engine.dispose()}await rm(root,{recursive:true,force:true}).catch(()=>{})}}
async function initialCommit(root,ctx,engine,session){await ctx.step(session,7);await settle(engine);await ctx.step(session,7);await settle(engine);session.append('step/start',{turn:1,step:7});session.append('assistant/message',{turn:1,step:7,usage:{inputTokens:10,outputTokens:2},message:{role:'assistant',content:[{type:'text',text:'第七步正文'}]},source:{kind:'assistant'}});session.append('step/end',{turn:1,step:7});await ctx.step(session,8);await settle(engine);await prep(root);await engine.setState(SESSION_ID,{mode:'cooling'});return await engine.archiveForStep(SESSION_ID,session,SETTINGS)}
test('C4-1 首次基线由真实 archiveForStep 生成',async()=>fixture(async({root,make})=>{const{ctx,engine}=make();const s=createFakeSession({cwd:'C:\\ws',contextWindow:1000000});seed(s);const r=await initialCommit(root,ctx,engine,s);assert.equal(r.status,'archived');assert.equal(r.policy.reason,'policy-baseline');assert.equal(r.policy.baselineReset,true)}))
test('C4-2 成功提交后 pre-step 推进请求间隔',async()=>fixture(async({root,make})=>{const{ctx,engine}=make();const s=createFakeSession({cwd:'C:\\ws',contextWindow:1000000});seed(s);const r=await initialCommit(root,ctx,engine,s);await ctx.step(s,9);await settle(engine);const d=await engine.archiveForStep(SESSION_ID,s,SETTINGS);assert.equal(d.status,'policy-deferred');assert.equal(d.policy.requestsSinceCommit,1);assert.equal(d.policy.reason,'rhythm-deferred')}))
test('C4-3 dispose 同根重建后 entry 基线丢失并重新 baseline',async()=>fixture(async({root,make})=>{let{ctx,engine}=make();const s=createFakeSession({cwd:'C:\\ws',contextWindow:1000000});seed(s);await initialCommit(root,ctx,engine,s);await engine.dispose();({ctx,engine}=make());await ctx.step(s,9);await settle(engine);await prep(root);await engine.setState(SESSION_ID,{mode:'cooling'});const d=await engine.archiveForStep(SESSION_ID,s,SETTINGS);assert.equal(d.policy.reason,'policy-baseline');assert.equal(d.policy.baselineReset,true);assert.equal(d.policy.decision,'allow')}))
test('C4-4 state.json 不持久化 policyState/lastCommit',async()=>fixture(async({root,make})=>{
  const{ctx,engine}=make();const s=createFakeSession({cwd:'C:\\ws',contextWindow:1000000});seed(s);await initialCommit(root,ctx,engine,s)
  // 第一段（原断言，保留）：首次归档写盘时 entry.policyState 仍是 null——setState 在 v3-entry.mjs
  // 第 1431 行、entry.policyState 赋值在第 1439 行，赋值晚于写盘。所以这段只是**现状快照**。
  const first=JSON.parse(await readFile(sessionStatePath(root,SESSION_ID),'utf8'))
  assert.equal(Object.hasOwn(first,'policyState'),false)
  assert.equal(Object.hasOwn(first,'lastCommit'),false)
  // 第二段（回归守卫）：此刻 entry.policyState 已被首次归档赋成非空，再跑一次真实归档→setState 写盘。
  // 若将来有人把 policyState 塞进归档路径的 setState patch 并让 domain 接受，这里读到的 state.json 就会带上该字段。
  growSteps(s,8,12)
  await new Promise((r)=>setTimeout(r,10))
  const again=await engine.archiveForStep(SESSION_ID,s,SETTINGS_NO_POLICY)
  assert.equal(again.status,'archived')
  const second=JSON.parse(await readFile(sessionStatePath(root,SESSION_ID),'utf8'))
  assert.ok(second.surface.lastArchiveAt>first.surface.lastArchiveAt) // 证明第二次确实走了 setState 写盘（不是早退）
  assert.equal(Object.hasOwn(second,'policyState'),false)
  assert.equal(Object.hasOwn(second,'lastCommit'),false)
  assert.deepEqual(Object.keys(second).sort(),Object.keys(first).sort())
}))
test('C4-5 重建重置朝向 allow 而非 defer',async()=>fixture(async({root,make})=>{let{ctx,engine}=make();const s=createFakeSession({cwd:'C:\\ws',contextWindow:1000000});seed(s);await initialCommit(root,ctx,engine,s);await engine.dispose();({ctx,engine}=make());await ctx.step(s,9);await settle(engine);await prep(root);await engine.setState(SESSION_ID,{mode:'cooling'});const d=await engine.archiveForStep(SESSION_ID,s,SETTINGS);assert.equal(d.policy.decision,'allow');assert.notEqual(d.policy.decision,'defer')}))

// P1 C4-4 升级（2026-11-03）：policyState 不是 session state / session control 的合法 patch 面。
// 既有行为是**静默忽略**（不是 bug，但必须锁住：将来有人「顺手支持」它就会改变持久化语义）。
test('C4-6 patchSessionState 不接受 policyState/lastCommit：误传静默忽略且不抛错', async () => {
  const current = emptySessionState('cooling')
  const next = patchSessionState(current, {
    mode: 'cooling',
    surface: { lastArchiveAt: 1 },
    policyState: { lastCommit: { attemptOrdinal: 2, messagesCount: 7 } },
    lastCommit: { attemptOrdinal: 2 },
    requestOrdinal: 9,
  })
  assert.equal(Object.hasOwn(next, 'policyState'), false)
  assert.equal(Object.hasOwn(next, 'lastCommit'), false)
  assert.equal(Object.hasOwn(next, 'requestOrdinal'), false)
  // 键集合恒定 = patch 面白名单没被扩宽（新增持久化字段必须先改 schema 与本节断言）。
  assert.deepEqual(Object.keys(next).sort(), Object.keys(current).sort())
  // 合法字段照常生效：证明上面的「无该键」不是因为整份 patch 被丢弃。
  assert.equal(next.surface.lastArchiveAt, 1)
})

test('C4-7 patchSessionControl 不接受 policyState：误传静默忽略且不抛错', async () => {
  const current = emptySessionControl()
  const next = patchSessionControl(current, {
    recall: true,
    policyState: { lastCommit: { attemptOrdinal: 2 } },
    lastCommit: { attemptOrdinal: 2 },
  })
  assert.equal(Object.hasOwn(next, 'policyState'), false)
  assert.equal(Object.hasOwn(next, 'lastCommit'), false)
  assert.deepEqual(Object.keys(next).sort(), Object.keys(current).sort())
})

// storage 层同一事实：错误 patch 走过跨进程写锁 + 归一化 + 原子写之后，磁盘上仍没有该字段。
test('C4-8 误把 policyState 塞进 setState patch 也不落盘', async () => fixture(async ({ root, make }) => {
  const { ctx, engine } = make()
  const s = createFakeSession({ cwd: 'C:\\ws', contextWindow: 1000000 })
  seed(s); await initialCommit(root, ctx, engine, s)
  const before = JSON.parse(await readFile(sessionStatePath(root, SESSION_ID), 'utf8'))
  await new Promise((r) => setTimeout(r, 10))
  await engine.setState(SESSION_ID, {
    surface: { lastArchiveEndSeq: before.surface.lastArchiveEndSeq, lastArchiveAt: Date.now() },
    policyState: { lastCommit: { attemptOrdinal: 9 } },
    lastCommit: { attemptOrdinal: 9 },
    requestOrdinal: 9,
  })
  const after = JSON.parse(await readFile(sessionStatePath(root, SESSION_ID), 'utf8'))
  assert.ok(after.surface.lastArchiveAt > before.surface.lastArchiveAt) // 写盘真的发生了（不是未就绪/损坏早退）
  assert.equal(Object.hasOwn(after, 'policyState'), false)
  assert.equal(Object.hasOwn(after, 'lastCommit'), false)
  assert.equal(Object.hasOwn(after, 'requestOrdinal'), false)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
}))

// C4-9（C6，2026-11-04 审计）：C4-7 只测了 patch 函数，属「经高层封装」的用例——封装本身
// 不认这个键，所以对**写原语**的透传是假绿。这里直接对 storage 写原语注入 policyState /
// lastCommit：写原语必须**失败关闭**（ESTATE_UNKNOWN_KEY / ECONTROL_UNKNOWN_KEY），
// 而不是「静默忽略后照常落盘」。若有人扩宽 normalize 的 allowed 集合，本用例必红。
test('C4-9 storage 写原语拒绝未知键（state 与 control 各一条），不产生任何落盘', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcl-c4-write-'))
  try {
    await assert.rejects(
      () => writeSessionState(root, 'c4-write', { mode: 'cooling', policyState: { lastCommit: { attemptOrdinal: 3 } } }),
      (error) => error.code === 'ESTATE_UNKNOWN_KEY',
    )
    await assert.rejects(
      () => writeSessionControl(root, 'c4-write', { enabled: false, policyState: { lastCommit: { attemptOrdinal: 3 } } }),
      (error) => error.code === 'ECONTROL_UNKNOWN_KEY',
    )
    await assert.rejects(() => readFile(sessionStatePath(root, 'c4-write')), (error) => error.code === 'ENOENT')
    await assert.rejects(() => readFile(sessionControlPath(root, 'c4-write')), (error) => error.code === 'ENOENT')

    // 合法字段照常写入（证明拒绝的原因是未知键，不是写原语整体不可用）。
    await writeSessionControl(root, 'c4-write', { enabled: false })
    assert.equal(JSON.parse(await readFile(sessionControlPath(root, 'c4-write'), 'utf8')).enabled, false)
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
