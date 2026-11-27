import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { stills, withCharset } from '../../src/review-media.ts';
import { PASSED_OVER_TAIL, fitReview, keepPictureMarkers, webLinksOnly } from '../../src/reviews.ts';
import type { ImageRef, ReviewDraft } from '../../src/protocol.ts';

function fixture() {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Compare these', accountId: 'claude-3' });
  h.adapter.last.init();
  const source = path.join(h.home, 'mockup.png');
  fs.writeFileSync(source, makePng(120, 80));
  const input = { title: 'Account picker', options: [
    { id: 'A', title: 'First', path: source },
    { id: 'B', title: 'Second', path: source },
    { id: 'D', title: 'Reference', path: source, reference: true },
  ] };
  return { h, thread, source, input };
}

test('review imports files, persists draft and stays needsYou after read and restart', () => {
  const {h, thread, source, input} = fixture();
  const {review} = h.runner.createReview(thread.id, input);
  assert.equal(h.runner.get(thread.id).needsYou, false, 'no Needs you while the turn that showed it is still running');
  assert.equal(review.options.length, 3);
  assert.notEqual(review.options[0].image.path, source);
  fs.unlinkSync(source);
  assert.ok(fs.existsSync(review.options[0].image.path));
  const saved = h.runner.saveReview(thread.id, review.id, review.revision, {pickedId:'B', notes:{D:'Keep this behaviour'}}).review;
  h.adapter.last.result();
  h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq);
  assert.equal(h.runner.get(thread.id).needsYou, true);
  assert.equal(h.runner.get(thread.id).pendingReviews, 1);
  const again = h.restart();
  assert.deepEqual(again.runner.getReview(thread.id, review.id).review.draft, saved.draft);
  assert.equal(again.runner.get(thread.id).needsYou, true);
});

test('review validation leaves no partial card or copied assets', () => {
  const {h,thread,input}=fixture();
  const count=h.runner.events(thread.id).events.length;
  for(const options of [[], [...input.options,{...input.options[0]}], [{...input.options[0], path:'/does/not/exist'}], [{...input.options[0], title:''}], [{...input.options[0], reference:'yes'}]]) {
    assert.throws(()=>h.runner.createReview(thread.id,{...input,options} as any));
  }
  assert.equal(h.runner.events(thread.id).events.length,count);
  assert.equal(h.runner.get(thread.id).pendingReviews,undefined);
});

test('review rejects stale writes, unknown IDs and reference picks, supports notes-only and cancel', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const saved=h.runner.saveReview(thread.id,review.id,0,{notes:{A:'More room'}}).review;
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,0,{notes:{}}),/changed|revision/i);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,saved.revision,{pickedId:'D',notes:{}}),/reference/i);
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,saved.revision,{notes:{wrong:'oops'}}),/option/i);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,saved.revision,{notes:{}}),/pick|note/i);
  const result=h.runner.respondReview(thread.id,review.id,saved.revision,{notes:{D:'Useful with either'}});
  assert.equal(result.review.status,'answered');
  assert.equal(result.review.response?.pickedId,undefined);
  const r2=h.runner.createReview(thread.id,input).review;
  assert.equal(h.runner.cancelReview(thread.id,r2.id,r2.revision).review.status,'cancelled');
  assert.throws(()=>h.runner.saveReview(thread.id,r2.id,1,{notes:{}}),/cancelled/i);
});

test('response queues after busy turn, includes metadata and duplicate retries never send twice', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const draft={pickedId:'B',notes:{A:'Too much chrome',D:'Looks good'}};
  const result=h.runner.respondReview(thread.id,review.id,review.revision,draft);
  assert.equal(h.adapter.last.sent.length,1);
  assert.equal(h.store.load(thread.id)?.queue.length,1);
  assert.deepEqual(h.runner.respondReview(thread.id,review.id,review.revision,draft),result);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,1,{pickedId:'A',notes:{}}),/answered/i);
  h.adapter.last.result(); await tick();
  assert.equal(h.adapter.last.sent.length,2);
  const messages=h.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message');
  assert.equal(messages.length,2);
  const reply=messages[1];
  assert.equal(reply.reviewId,review.id);
  assert.deepEqual(reply.reviewResponse,draft);
  assert.match(reply.text,/Account picker/);
  assert.match(reply.text,/Picked B/);
  assert.match(reply.text,/Notes on D/);
  // The one he didn't pick is named, so a follow-up can't offer it as new; the reference isn't.
  assert.match(reply.text,/\n\nPassed over: A\. First\. Don't offer one of these later/);
  assert.doesNotMatch(reply.text,/Passed over:.*Reference/);
  assert.equal(h.runner.get(thread.id).pendingReviews,undefined);
});

test('accepted review reply survives restart before a busy turn finishes', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const draft={pickedId:'A',notes:{}};
  const sent=h.runner.respondReview(thread.id,review.id,review.revision,draft);
  const again=h.restart(); await tick();
  assert.deepEqual(again.runner.respondReview(thread.id,review.id,0,draft),sent);
  assert.equal(again.adapter.last.sent.length,1);
  assert.match(again.adapter.last.sent[0].text,/Picked A/);
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message'&&e.reviewId===review.id).length,1);
});

test('show_options uses the calling thread and returns a review ID without waiting', async () => {
  const {h,thread,input}=fixture();
  const tool=buildThreadbearTools(h.runner,thread.id).find(t=>t.name==='show_options');
  assert.ok(tool);
  const result=await tool.handler(input as any,{} as any);
  assert.equal(result.isError,undefined);
  assert.match(JSON.stringify(result),/review|choice|later/i);
  assert.equal(h.runner.get(thread.id).pendingReviews,1);
});

test('show_options tells the agent which shots are too tall for the app to draw in full', async () => {
  const {h,thread,input}=fixture();
  const tall=path.join(h.home,'phone.png');
  fs.writeFileSync(tall,makePng(2,17000));
  const tool=buildThreadbearTools(h.runner,thread.id).find(t=>t.name==='show_options')!;
  const fine=JSON.stringify(await tool.handler(input as any,{} as any));
  assert.doesNotMatch(fine,/shrunk/);
  const withTall={...input,options:input.options.map(o=>o.id==='B'?{...o,shots:[{path:tall}]}:o)};
  const warned=JSON.stringify(await tool.handler(withTall as any,{} as any));
  assert.match(warned,/B shot 2 \(2 x 17000\)/);
  assert.match(warned,/split each into shots no more than 16384 px/);
});

test('failed atomic save keeps a review pending, and an accepted outbox repairs a missing card after restart', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const save=h.store.save.bind(h.store);
  h.store.save=()=>{throw new Error('disk full')};
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}}),/disk full/);
  h.store.save=save;
  assert.equal(h.runner.getReview(thread.id,review.id).review.status,'pending');
  assert.equal(h.store.load(thread.id)?.queue.length,0);
  const log=h.store.log(thread.id);
  const append=log.append.bind(log);
  log.append=()=>{throw new Error('event append failed')};
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}}),/append failed/);
  log.append=append;
  assert.equal(h.store.load(thread.id)?.reviews?.[0].status,'answered');
  const again=h.restart();await tick();
  assert.equal(again.runner.getReview(thread.id,review.id).review.status,'answered');
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='review.updated'&&e.review.status==='answered').length,1);
  assert.equal(again.adapter.last.sent.length,1);
});

test('a stale outbox saved before user.message was appended does not replay an already delivered answer', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}});
  const queue=structuredClone(h.store.load(thread.id)!.queue);
  h.adapter.last.result();await tick();
  const rec=h.store.load(thread.id)!;
  rec.queue=queue;h.store.save(rec);
  const again=h.restart();await tick();
  assert.equal(again.adapter.sessions.length,0);
  assert.equal(again.store.load(thread.id)!.queue.length,0);
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message'&&e.reviewId===review.id).length,1);
});

test('review RPC methods validate, save, answer and reopen through the authenticated server', async () => {
  const {RpcServer}=await import('../../src/rpc.ts');
  const {RunnerClient}=await import('../../src/client.ts');
  const {nullLogger}=await import('../../src/log.ts');
  const {h,thread,input}=fixture();
  const server=new RpcServer({host:'127.0.0.1',port:0,token:'test-review-token',runner:h.runner,log:nullLogger});
  const {port}=await server.listen();
  const client=await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`,'test-review-token');
  try {
    await assert.rejects(client.call('reviews.create',{threadId:thread.id,title:'bad',options:[]}), (e:any)=>e.code===-32602);
    const {review}=await client.call('reviews.create',{threadId:thread.id,...input});
    assert.equal((await client.call('reviews.list',{threadId:thread.id})).reviews[0].id,review.id);
    for (const method of ['reviews.get','reviews.list','reviews.cancel']) {
      await assert.rejects(client.call(method,{threadId:42,reviewId:42,revision:0}),(e:any)=>e.code===-32602);
    }
    const saved=await client.call('reviews.save',{threadId:thread.id,reviewId:review.id,revision:review.revision,draft:{pickedId:'B',notes:{A:'Too much'}}});
    assert.equal(saved.review.revision,1);
    await assert.rejects(client.call('reviews.save',{threadId:thread.id,reviewId:review.id,revision:0,draft:{notes:{}}}),(e:any)=>e.code===-32602);
    const answered=await client.call('reviews.respond',{threadId:thread.id,reviewId:review.id,revision:1,draft:saved.review.draft});
    assert.equal(answered.review.status,'answered');
    assert.deepEqual((await client.call('reviews.list',{threadId:thread.id})).reviews,[]);
    const reopened=await client.call('reviews.get',{threadId:thread.id,reviewId:review.id});
    assert.deepEqual(reopened.review.response,saved.review.draft);
    const another=(await client.call('reviews.create',{threadId:thread.id,...input})).review;
    assert.equal((await client.call('reviews.cancel',{threadId:thread.id,reviewId:another.id,revision:0})).review.status,'cancelled');
  } finally {client.close();await server.close();}
});

test('an answered review reconstructs its outbox if queue removal was saved before dispatch', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'B',notes:{}});
  const rec=h.store.load(thread.id)!;
  rec.queue=[];h.store.save(rec);
  const again=h.restart();await tick();
  assert.match(again.adapter.last.sent[0].text,/Picked B/);
});

test('show_options is shared with Codex dynamic tools and routes to the runner owning the thread', async () => {
  const {dynamicToolSpecs}=await import('../../src/adapters/codex/tools.ts');
  const {ThreadRouter}=await import('../../src/handover.ts');
  const {h,thread,input}=fixture();
  const tools=buildThreadbearTools(h.runner,thread.id,Date.now,undefined,undefined,undefined,{provider:'codex'});
  const specs=dynamicToolSpecs(tools);
  assert.match(JSON.stringify(specs),/show_options/);
  const calls:{method:string;params:unknown}[]=[];
  const router=new ThreadRouter(h.runner,()=>({
    owns:(id:string)=>id==='remote-thread',
    call:async(method:string,params:unknown)=>{calls.push({method,params});return {review:{id:'remote-review'}}},
  } as any));
  const reply=await router.createReview('remote-thread',input);
  assert.equal(reply.review.id,'remote-review');
  assert.deepEqual(calls,[{method:'reviews.create',params:{threadId:'remote-thread',...input}}]);
  assert.equal((await router.createReview(thread.id,input)).review.title,input.title);
});

test('review reply survives a failed turn.started append after its user.message was saved', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  const log=h.store.log(thread.id);
  const append=log.append.bind(log);
  log.append=(event)=>{if(event.type==='turn.started') throw new Error('disk full');append(event)};
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'B',notes:{}});
  assert.equal(h.adapter.last.sent.length,1,'no second message reached the CLI');
  log.append=append;
  const again=h.restart();await tick();
  assert.equal(again.adapter.last.sent.length,1);
  assert.match(again.adapter.last.sent[0].text,/Picked B/);
  assert.equal(again.runner.events(thread.id,{limit:1000}).events.filter(e=>e.type==='user.message'&&e.reviewId===review.id).length,1);
  assert.deepEqual(again.store.load(thread.id)?.reviewDeliveries,[review.id]);
});

test('special option IDs do not invent notes from Object.prototype', () => {
  const {h,thread,input}=fixture();
  input.options[0].id='__proto__';input.options[1].id='constructor';
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'constructor',notes:{}});
  const queued=h.store.load(thread.id)!.queue[0];
  assert.match(queued.text,/Picked constructor/);
  assert.doesNotMatch(queued.text,/Notes on|Object|native code/);
});


test('pending reviews list stays oldest-first after draft changes', () => {
  const {h,thread,input}=fixture();
  const first=h.runner.createReview(thread.id,input).review;
  h.clock.advance(1);
  const second=h.runner.createReview(thread.id,input).review;
  h.runner.saveReview(thread.id,first.id,0,{pickedId:'A',notes:{}});
  assert.deepEqual(h.runner.listReviews(thread.id).reviews.map(r=>r.id),[first.id,second.id]);
});

test('a reply whose session.send fails is recovered after restart', async () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  h.adapter.last.send=()=>{throw new Error('CLI unavailable')};
  h.runner.respondReview(thread.id,review.id,0,{pickedId:'A',notes:{}});
  await tick();
  assert.equal(h.store.load(thread.id)?.reviewDeliveries,undefined);
  const again=h.restart();await tick();
  assert.match(again.adapter.last.sent[0].text,/Picked A/);
  assert.deepEqual(again.store.load(thread.id)?.reviewDeliveries,[review.id]);
});

test('a message from Alex supersedes open reviews; runner, schedule and agent messages do not', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  h.runner.send(thread.id,'reminder',[],{origin:'schedule'});
  h.runner.send(thread.id,'carry on',[],{origin:'runner'});
  h.runner.send(thread.id,'[Sent by the agent in the thread "Other" (abcd1234)]\n\nhello');
  assert.equal(h.runner.getReview(thread.id,review.id).review.status,'pending');
  assert.equal(h.runner.get(thread.id).pendingReviews,1);
  h.runner.send(thread.id,'Actually, build a mock app first');
  const after=h.runner.getReview(thread.id,review.id).review;
  assert.equal(after.status,'superseded');
  assert.equal(after.revision,review.revision+1);
  assert.equal(h.runner.get(thread.id).pendingReviews,undefined);
  assert.deepEqual(h.runner.listReviews(thread.id).reviews,[]);
  assert.throws(()=>h.runner.respondReview(thread.id,review.id,after.revision,{pickedId:'A',notes:{}}),/superseded/);
  const last=h.runner.events(thread.id).events.filter(e=>e.type==='review.updated').at(-1);
  assert.equal(last?.type==='review.updated'&&last.review.status,'superseded');
});

test('a message from the phone supersedes open reviews too', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.adapter.last.result();
  h.runner.send(thread.id,'from my phone',[],{origin:'phone'});
  assert.equal(h.runner.getReview(thread.id,review.id).review.status,'superseded');
});

// An option's several shots used to be options of their own (A2, A3) that
// couldn't be picked; and Mike often wants two of them, or none, in his own
// words (4 Nov).
test('an option keeps its shots and url, and old single-image options are unchanged', () => {
  const {h,thread,source}=fixture();
  const {review}=h.runner.createReview(thread.id,{title:'Diagrams',options:[
    {id:'A',title:'Board',path:source,url:'http://localhost:5190/a',shots:[{path:source,title:'Mid-drag'},{path:source,title:'Detail'}]},
    {id:'B',title:'Dossier',shots:[{path:source,title:'Overview'},{path:source}]},
    {id:'C',title:'Map',path:source},
  ]});
  const [a,b,c]=review.options;
  assert.equal(a.shots?.length,3);
  assert.equal(a.shots?.[0].image.path,a.image.path,'image is the first shot, for clients that show one');
  assert.deepEqual(a.shots?.map(s=>s.title),[undefined,'Mid-drag','Detail']);
  assert.equal(a.url,'http://localhost:5190/a');
  assert.equal(new Set(a.shots?.map(s=>s.image.path)).size,3,'each shot is its own copy');
  assert.deepEqual(b.shots?.map(s=>s.title),['Overview',undefined]);
  assert.equal(c.shots,undefined);
  assert.equal(c.url,undefined);
  for (const bad of [
    {id:'X',title:'No picture'},
    {id:'X',title:'Bad url',path:source,url:'javascript:alert(1)'},
    {id:'X',title:'Too many',shots:Array.from({length:9},()=>({path:source}))},
    {id:'X',title:'Missing',path:source,shots:[{path:'/does/not/exist'}]},
  ]) assert.throws(()=>h.runner.createReview(thread.id,{title:'Bad',options:[bad as any]}),/./,JSON.stringify(bad));
  assert.throws(()=>h.runner.createReview(thread.id,{title:'Too big',options:Array.from({length:6},(_,i)=>({id:`O${i}`,title:'Many',shots:Array.from({length:7},()=>({path:source}))}))}),/at most 40/);
});

test('recommended marks the agent\'s pick, and must name an option that can be picked', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,{...input,recommended:'B'});
  assert.equal(review.recommended,'B');
  assert.equal(h.restart().runner.getReview(thread.id,review.id).review.recommended,'B');
  assert.equal(h.runner.createReview(thread.id,input).review.recommended,undefined);
  assert.throws(()=>h.runner.createReview(thread.id,{...input,recommended:'Z'}),/option ids/);
  assert.throws(()=>h.runner.createReview(thread.id,{...input,recommended:'D'}),/reference/);
});

test('several picks, none, and a reply go to the agent in the order of the options', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const saved=h.runner.saveReview(thread.id,review.id,0,{pickedIds:['B','A'],notes:{},reply:'  The board, with the sandbox for the video. '}).review;
  assert.deepEqual(saved.draft,{pickedId:'A',pickedIds:['A','B'],notes:{},reply:'The board, with the sandbox for the video.'});
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,saved.revision,{pickedIds:['A'],none:true,notes:{}}),/none/i);
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,saved.revision,{pickedIds:['A','D'],notes:{}}),/reference/i);
  // An older client's pickedId alone still works.
  const old=h.runner.saveReview(thread.id,review.id,saved.revision,{pickedId:'B',notes:{}}).review;
  assert.deepEqual(old.draft,{pickedId:'B',notes:{}});
  const answered=h.runner.respondReview(thread.id,review.id,old.revision,{pickedIds:['A','B'],notes:{D:'Keep this'},reply:'Both, please.'});
  const sent=h.store.load(thread.id)!.queue.at(-1)!;
  assert.equal(sent.text,`Review: Account picker (${review.id})\n\nPicked A + B. First + Second.\n\nBoth, please.\n\nNotes on D (Reference): Keep this`);
  // Everything that could be picked was, so nothing was passed over.
  // Retrying the same answer is the same answer, whichever order it came in.
  assert.equal(h.runner.respondReview(thread.id,review.id,old.revision,{pickedIds:['B','A'],notes:{D:'Keep this'},reply:'Both, please.'}).turnId,answered.turnId);
});

test('none of them, with or without a reply, is an answer', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  h.runner.respondReview(thread.id,review.id,0,{none:true,notes:{}});
  const sent=h.store.load(thread.id)!.queue.at(-1)!;
  assert.equal(sent.text,`Review: Account picker (${review.id})\n\nPicked none of them.`);
  const second=h.runner.createReview(thread.id,input).review;
  h.runner.respondReview(thread.id,second.id,0,{notes:{},reply:'Can you explain what these are for?'});
  const reply=h.store.load(thread.id)!.queue.at(-1)!;
  assert.equal(reply.text,`Review: Account picker (${second.id})\n\nCan you explain what these are for?`);
});

// The smallest file sniffVideo calls an MP4: an ftyp box, nothing to play.
function fakeMp4(): Buffer {
  const box = Buffer.alloc(16);
  box.writeUInt32BE(16, 0);
  box.write('ftypisom', 4, 'ascii');
  return box;
}

test('a shot can be a video or an HTML page: copied with a still, and the page brings what it names', (t) => {
  // Nothing here can draw the fake clip, and Quick Look hangs on it till its timeout.
  t.mock.method(stills,'quickLook',()=>undefined);
  t.mock.method(stills,'ffmpegFrame',()=>undefined);
  const {h,thread,source}=fixture();
  const clip=path.join(h.home,'clip.mp4');
  fs.writeFileSync(clip,fakeMp4());
  const site=path.join(h.home,'site');
  fs.mkdirSync(path.join(site,'img'),{recursive:true});
  fs.writeFileSync(path.join(site,'img','a.png'),makePng(4,4));
  fs.writeFileSync(path.join(site,'style.css'),'body{background:url("img/bg.png")}');
  fs.writeFileSync(path.join(site,'img','bg.png'),makePng(2,2));
  fs.writeFileSync(path.join(h.home,'secret.txt'),'not for the page');
  fs.writeFileSync(path.join(site,'other.html'),'<p>another page</p>');
  fs.symlinkSync(path.join(h.home,'secret.txt'),path.join(site,'linked.png'));
  const page=path.join(site,'index.html');
  fs.writeFileSync(page,'<link rel="stylesheet" href="style.css"><img src="img/a.png?v=2"><img src="../secret.txt"><img src="linked.png"><img src="https://example.com/x.png"><a href="other.html">next</a>');
  const {review}=h.runner.createReview(thread.id,{title:'Clips',options:[
    {id:'A',title:'Clip',path:clip},
    {id:'B',title:'Page',path:source,shots:[{path:page,title:'Live'}]},
  ]});
  const [a,b]=review.options;
  assert.equal(a.shots?.length,1,'a lone video still comes as a shot, so its media isn’t lost');
  assert.equal(a.shots?.[0].media?.mediaType,'video/mp4');
  assert.notEqual(a.shots?.[0].media?.path,clip);
  assert.deepEqual(fs.readFileSync(a.shots![0].media!.path),fakeMp4());
  assert.equal(a.image.path,a.shots?.[0].image.path,'the option’s image is the video’s still');
  assert.ok(fs.existsSync(a.image.path)&&a.image.width&&a.image.height,'a still even when nothing can draw this clip');
  assert.equal(b.shots?.[0].media,undefined,'a picture has no media');
  const copied=b.shots![1].media!;
  assert.equal(copied.mediaType,'text/html');
  assert.equal(path.basename(copied.path),'index.html');
  const folder=path.dirname(copied.path);
  for (const f of ['style.css','img/a.png','img/bg.png']) assert.ok(fs.existsSync(path.join(folder,f)),f);
  assert.ok(!fs.existsSync(path.join(folder,'..','secret.txt')),'nothing from outside the page’s folder');
  assert.ok(!fs.existsSync(path.join(folder,'other.html')),'other pages aren’t followed');
  assert.ok(!fs.existsSync(path.join(folder,'linked.png')),'nor a link out of the folder');
  assert.ok(fs.existsSync(b.shots![1].image.path));
  const notes=path.join(h.home,'notes.txt');
  fs.writeFileSync(notes,'plain text');
  assert.throws(()=>h.runner.createReview(thread.id,{title:'Bad',options:[{id:'X',title:'Text',path:notes}]}),/video \(MP4, MOV\), sound \(MP3, M4A, AAC, WAV\) or HTML page/);
});

// Two MPEG-1 layer III frames at 128 kbps, 44.1 kHz: 417 bytes each.
function mp3Frames(): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat([frame, frame]);
}

// Two ADTS (AAC) frames of 20 bytes, no CRC.
function adtsFrames(): Buffer {
  const frame = Buffer.alloc(20);
  frame.set([0xff, 0xf1, 0x50, 0x80, 20 >> 3, (20 & 7) << 5 | 0x1f, 0xfc]);
  return Buffer.concat([frame, frame]);
}

// Mike, 24 Nov: comparing music beds and sounds as options.
function fakeSounds(): Record<string, Buffer> {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  const m4a = Buffer.alloc(16);
  m4a.writeUInt32BE(16, 0);
  m4a.write('ftypM4A ', 4, 'ascii');
  return {
    'bed.mp3': Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), mp3Frames()]),
    'frames.mp3': mp3Frames(),
    'bed.m4a': m4a,
    'isom.m4a': fakeMp4(),
    'raw.aac': adtsFrames(),
    'ding.wav': wav,
  };
}

test('a shot can be a sound: sniffed by its bytes, copied with its waveform or a card, and over 100 MB refused', (t) => {
  t.mock.method(stills,'quickLook',(file:string)=>{ assert.ok(file.endsWith('.mp4'),'a sound’s still is its waveform, not Quick Look’s'); return undefined; });
  const waves=t.mock.method(stills,'ffmpegWaveform',()=>undefined);
  const {h,thread}=fixture();
  const sounds=fakeSounds();
  for (const [name,bytes] of Object.entries(sounds)) fs.writeFileSync(path.join(h.home,name),bytes);
  const {review}=h.runner.createReview(thread.id,{title:'Beds',options:Object.keys(sounds).map((name,i)=>({id:String(i),title:name,path:path.join(h.home,name)}))});
  assert.deepEqual(review.options.map(o=>o.shots?.[0].media?.mediaType),['audio/mpeg','audio/mpeg','audio/mp4','audio/mp4','audio/aac','audio/wav']);
  assert.deepEqual(review.options.map(o=>path.extname(o.shots![0].media!.path)),['.mp3','.mp3','.m4a','.m4a','.aac','.wav']);
  for (const [i,o] of review.options.entries()) {
    assert.deepEqual(fs.readFileSync(o.shots![0].media!.path),Object.values(sounds)[i]);
    assert.ok(o.image.width&&o.image.height&&fs.existsSync(o.image.path),'the dark card when ffmpeg can’t draw it');
  }
  assert.equal(waves.mock.callCount(),6);
  // An MP4 named .mp4 is still a video, and a waveform ffmpeg draws is the still.
  t.mock.method(stills,'ffmpegFrame',()=>undefined);
  const clip=path.join(h.home,'clip.mp4');
  fs.writeFileSync(clip,fakeMp4());
  waves.mock.mockImplementation((_file:string,out:string)=>{ const p=path.join(out,'wave.png'); fs.writeFileSync(p,makePng(160,90)); return p; });
  const two=h.runner.createReview(thread.id,{title:'Mixed',options:[{id:'A',title:'Clip',path:clip},{id:'B',title:'Bed',path:path.join(h.home,'bed.mp3')}]}).review;
  assert.equal(two.options[0].shots?.[0].media?.mediaType,'video/mp4');
  assert.deepEqual([two.options[1].image.width,two.options[1].image.height],[160,90]);
  const big=path.join(h.home,'long.wav');
  fs.writeFileSync(big,sounds['ding.wav']);
  fs.truncateSync(big,100*1024*1024+1);
  assert.throws(()=>h.runner.createReview(thread.id,{title:'Big',options:[{id:'A',title:'Long',path:big}]}),/sound must be at most 100 MB/);
});

test('a moved review keeps a sound only by its name and bytes', () => {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tb-moved-sound-'));
  const id='0f9e8d7c-1111-4222-8333-444455556666';
  const rid='5a4b3c2d-aaaa-4bbb-8ccc-ddddeeeeffff';
  const now=path.join(root,'media');
  const media={threadId:id,now,final:now};
  fs.mkdirSync(path.join(now,'reviews',rid),{recursive:true});
  fs.writeFileSync(path.join(now,'reviews',rid,'still.png'),makePng(12,8));
  const sounds=fakeSounds();
  for (const name of ['bed.mp3','bed.m4a','ding.wav']) fs.writeFileSync(path.join(now,'reviews',rid,name),sounds[name]);
  // A sound's bytes under a page's name, and a page's under a sound's.
  fs.writeFileSync(path.join(now,'reviews',rid,'bed.svg'),sounds['ding.wav']);
  fs.writeFileSync(path.join(now,'reviews',rid,'page.wav'),'<script>x()</script>');
  const theirs=(rest:string,mediaType='image/png')=>({path:`/home/someone/.threadbear/threads/${id}/media/reviews/${rid}/${rest}`,mediaType});
  const fitted=fitReview({id:rid,title:'T',status:'pending',revision:1,createdAt:'c',updatedAt:'c',draft:{notes:{}},
    options:[{id:'A',title:'A',image:theirs('still.png'),shots:['bed.mp3','bed.m4a','ding.wav','bed.svg','page.wav'].map(f=>({image:theirs('still.png'),media:theirs(f,'audio/mpeg')}))}]},media)!;
  assert.deepEqual(fitted.options[0]!.shots!.map(s=>s.media?.mediaType),['audio/mpeg','audio/mp4','audio/wav',undefined,undefined]);
  fs.rmSync(root,{recursive:true,force:true});
});

// Mike, 7 Nov: a mockup with ✓ and no charset showed "âœ“" in the review
// window and its still, both of which read an undeclared page as Latin-1.
test('a review page that is UTF-8 without saying so gets a charset in its copy', () => {
  const page=(s:string|Buffer)=>withCharset(Buffer.isBuffer(s)?s:Buffer.from(s,'utf8')).toString('latin1');
  assert.equal(page('<p>✓ done</p>'),Buffer.from('<meta charset="utf-8"><p>✓ done</p>','utf8').toString('latin1'));
  assert.match(page('<!DOCTYPE html><html><p>✓</p>'),/^<!DOCTYPE html><meta charset="utf-8"><html>/,'after the doctype, so no quirks mode');
  for (const s of ['<head><meta charset="windows-1252"></head>✓','<meta http-equiv="Content-Type" content="text/html; charset=utf-8">✓','﻿<p>✓</p>'])
    assert.equal(page(s),Buffer.from(s,'utf8').toString('latin1'),'its own declaration or BOM stands');
  const latin1=Buffer.from([0x3c,0x70,0x3e,0xe9,0x3c,0x2f,0x70,0x3e]); // <p>é</p> in Latin-1, not valid UTF-8
  assert.deepEqual(withCharset(latin1),latin1,'a page in another encoding is left alone');
});

// The bubbles leave the "Passed over:" line out by its wording, so theirs must match.
test('the Mac, phone and GPUI bubbles know the passed-over line', () => {
  const root=path.join(import.meta.dirname,'../../..');
  for (const file of ['app/Sources/ThreadbearCore/Protocol/DesignReview.swift','ios/ThreadbearKit/Sources/ThreadbearKit/ReviewAnswer.swift','desktop/core/src/reducer/event.rs'])
    assert.ok(fs.readFileSync(path.join(root,file),'utf8').includes(JSON.stringify(PASSED_OVER_TAIL)),file);
});

// Mike, 17 Nov: a picture pasted in the review window went in as its file
// path. A reply carries pictures as a message does, [Picture N] in its words.
test('a reply can carry pictures: kept with the review, sent with the answer, only from inbox/', async () => {
  const {h,thread,source,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const pasted=h.runner.importMedia(source).image;
  const saved=h.runner.saveReview(thread.id,review.id,0,{pickedId:'A',notes:{},reply:'Is the apple cut off? [Picture 1]',images:[pasted]}).review;
  const kept=saved.draft.images![0];
  assert.notEqual(kept.path,pasted.path,'copied in beside the review, so inbox/ can be cleaned');
  assert.match(kept.path,new RegExp(`reviews[\\\\/]${review.id}[\\\\/]reply[\\\\/]`));
  assert.equal(kept.mediaType,'image/png');
  // Saved again as the window has it now: the same copy, not another.
  const again=h.runner.saveReview(thread.id,review.id,saved.revision,{...saved.draft}).review;
  assert.equal(again.draft.images![0].path,kept.path);
  assert.equal(fs.readdirSync(path.dirname(kept.path)).length,1);
  // Any other file is refused, a link into inbox/ too.
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,again.revision,{notes:{},images:[{path:source,mediaType:'image/png'}]}),/media.import/);
  const link=path.join(path.dirname(pasted.path),'link.png');
  fs.symlinkSync(source,link);
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,again.revision,{notes:{},images:[{path:link,mediaType:'image/png'}]}),/not found/i);
  assert.throws(()=>h.runner.saveReview(thread.id,review.id,again.revision,{notes:{},images:'x'} as any),/list/);
  // Pictures alone are an answer; a retry naming the inbox copy is the same one.
  const second=h.runner.createReview(thread.id,input).review;
  const answer={notes:{},images:[pasted]};
  const sent=h.runner.respondReview(thread.id,second.id,0,answer);
  assert.deepEqual(h.runner.respondReview(thread.id,second.id,0,answer),sent);
  const answered=h.runner.respondReview(thread.id,review.id,again.revision,{pickedId:'A',notes:{},reply:'Is the apple cut off? [Picture 1]',images:[pasted]});
  assert.equal(answered.review.status,'answered');
  h.adapter.last.result(); await tick();
  h.adapter.last.result(); await tick();
  const message=h.runner.events(thread.id,{limit:1000}).events.find(e=>e.type==='user.message'&&e.reviewId===review.id) as any;
  assert.ok(message,'the answer went to the agent');
  assert.equal(message.images.length,1);
  assert.match(message.text,/Picked A\. First\.\n\nIs the apple cut off\? \[Picture 1\]/);
  // Its copy outlives inbox/.
  fs.rmSync(pasted.path);
  assert.ok(fs.existsSync(message.images[0].path));
});

test('a client from before reply pictures keeps them; a moved review brings none', () => {
  const {h,thread,source,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const pasted=h.runner.importMedia(source).image;
  const saved=h.runner.saveReview(thread.id,review.id,0,{notes:{},reply:'[Picture 1]',images:[pasted]}).review;
  // The Swift app's draft has no images: the saved one stays with its marker.
  const older=h.runner.saveReview(thread.id,review.id,saved.revision,{pickedId:'A',notes:{},reply:'[Picture 1]'}).review;
  assert.deepEqual(older.draft.images,saved.draft.images);
  // images: [] takes it away.
  assert.equal(h.runner.saveReview(thread.id,review.id,older.revision,{notes:{},images:[]}).review.draft.images,undefined);
  // Another runner's pictures name its files, which could be any file here.
  const own={threadId:thread.id,now:h.store.mediaDir(thread.id),final:h.store.mediaDir(thread.id)};
  const moved=fitReview({...review,status:'answered',replyTurnId:'t',response:{notes:{},images:[{path:'/Users/someone/private.png',mediaType:'image/png'}]},draft:{notes:{},images:[{path:'/etc/hosts',mediaType:'image/png'}]}},own)!;
  assert.equal(moved.response!.images,undefined);
  assert.equal(moved.draft.images,undefined);
  // Recovered from the log, as a moved thread's own events are: only this
  // review's own copies stay.
  const st=(h.runner as any).threads.get(thread.id);
  const kept=older.draft.images![0];
  const link=path.join(path.dirname(kept.path),'link.png');
  fs.symlinkSync(source,link);
  const fitted=h.runner.ownReplyImages(st,{...review,draft:{notes:{},images:[kept,{path:'/etc/hosts',mediaType:'image/png'},{path:link,mediaType:'image/png'}]},response:{notes:{},images:[{path:source,mediaType:'image/png'}]}});
  assert.deepEqual(fitted.draft.images,[kept]);
  assert.equal(fitted.response!.images,undefined);
  // An id that climbs out of the reviews folder owns nothing, even pictures that are real copies.
  const climbing=path.relative(path.join(h.store.mediaDir(thread.id),'reviews'),path.dirname(path.dirname(kept.path)));
  assert.equal(h.runner.ownReplyImage(st,`../reviews/${climbing}`,kept),false);
  assert.equal(h.runner.ownReplyImage(st,review.id,kept),true);
  // A queued answer keeps only its own pictures through recovery.
  st.rec.queue.push({turnId:'t-q',text:'x',images:[kept,{path:source,mediaType:'image/png'}],reviewId:review.id,reviewResponse:{notes:{},images:[{path:source,mediaType:'image/png'}]}});
  h.runner.recoverReviews(st);
  const queued=st.rec.queue.find((q:any)=>q.turnId==='t-q');
  assert.deepEqual(queued.images,[kept]);
  assert.deepEqual(queued.reviewResponse.images,[]);
  // A malformed one can't make the check fail open.
  st.rec.queue.push({turnId:'t-bad',text:'x',images:[{path:source,mediaType:'image/png'}, null],reviewId:review.id,reviewResponse:{notes:{},images:{}}} as any);
  h.runner.recoverReviews(st);
  const bad=st.rec.queue.find((q:any)=>q.turnId==='t-bad');
  assert.deepEqual(bad.images,[]);
  assert.deepEqual(bad.reviewResponse.images,[]);
  // Nor can a log event that isn't a review: the queue is checked first.
  st.rec.queue.push({turnId:'t-log',text:'x',images:[{path:source,mediaType:'image/png'}],reviewId:review.id} as any);
  const log=h.store.log(thread.id);
  log.append({seq:log.lastSeq+1,ts:new Date().toISOString(),type:'review.updated',review:null} as any);
  h.runner.recoverReviews(st);
  assert.deepEqual(st.rec.queue.find((q:any)=>q.turnId==='t-log').images,[]);
});

// Codex's review, 17 Nov: a moved thread's queue is another runner's word,
// and a recovery step that throws on it left its pictures unchecked, to be
// sent next. Whatever path a queued message took, only the thread's own
// pictures (its media folder, a review's reply copies) reach the agent.
// Daybreak 159 (21 Nov 2026): a moved review's files are the other runner's
// word, and the review window reads them as this Mac's once the thread is
// here. Only the ones that came with the move stay, as this thread's copies.
test('a moved review keeps only the files that came with it, as this thread\'s copies', () => {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tb-moved-review-'));
  const id='0f9e8d7c-1111-4222-8333-444455556666';
  const rid='5a4b3c2d-aaaa-4bbb-8ccc-ddddeeeeffff';
  const now=path.join(root,'stage','thread','media');
  const final=path.join(root,'threads',id,'media');
  const media={threadId:id,now,final};
  // What came with the move: a picture, a video's still and copy, a page in its folder.
  fs.mkdirSync(path.join(now,'reviews',rid,'pagedir'),{recursive:true});
  for (const f of ['a.png','still.png']) fs.writeFileSync(path.join(now,'reviews',rid,f),makePng(12,8));
  fs.writeFileSync(path.join(now,'reviews',rid,'clip.mp4'),fakeMp4());
  fs.writeFileSync(path.join(now,'reviews',rid,'pagedir/index.html'),'<p>page</p>');
  // A page the other runner calls a video, and a file that's neither.
  fs.writeFileSync(path.join(now,'reviews',rid,'payload.html'),'<script>x()</script>');
  fs.writeFileSync(path.join(now,'reviews',rid,'payload.bin'),'x');
  // A video's first bytes under names that aren't a video's, and a picture's
  // under a page's name (Codex's and Gemini's second reviews).
  fs.writeFileSync(path.join(now,'reviews',rid,'clip.svg'),Buffer.concat([fakeMp4(),Buffer.from('<svg onload="x()"/>')]));
  fs.writeFileSync(path.join(now,'reviews',rid,'clip.pdf'),Buffer.concat([fakeMp4(),Buffer.from('%PDF-1.4')]));
  fs.writeFileSync(path.join(now,'reviews',rid,'still.html'),makePng(12,8));
  // This Mac's own files, at paths the other runner named.
  const local=path.join(root,'mine');
  fs.mkdirSync(local);
  for (const f of ['secret.png','home.mp4','notes.html']) fs.writeFileSync(path.join(local,f),'x');
  // A link that came along as if packed (an older runner placed it).
  fs.symlinkSync(path.join(local,'secret.png'),path.join(now,'reviews',rid,'link.png'));
  const theirs=(rest:string)=>({path:`/home/someone/.threadbear/threads/${id}/media/reviews/${rid}/${rest}`,mediaType:'image/png'});
  const raw={id:rid,title:'T',status:'pending',revision:1,createdAt:'c',updatedAt:'c',recommended:'gone',
    note:'See [the file](/etc/passwd) or [the site](https://example.com/x) and \\[kept](./x)',
    options:[
      {id:'ok',title:'Came',note:'[open](file:///Users/m/secret.png)',url:'file:///etc/passwd',image:theirs('a.png'),shots:[
        {image:theirs('a.png')},
        {image:theirs('still.png'),media:{...theirs('clip.mp4'),mediaType:'video/mp4'}},
        {image:theirs('still.png'),media:{...theirs('pagedir/index.html'),mediaType:'text/html'}},
        {image:{path:path.join(local,'secret.png'),mediaType:'image/png'}},
        {image:theirs('still.png'),media:{path:path.join(local,'home.mp4'),mediaType:'video/mp4'}},
        {image:theirs('link.png')},
        {image:theirs('../../../../../mine/secret.png')},
        {image:theirs('still.png'),media:{...theirs('payload.html'),mediaType:'video/mp4'}},
      ]},
      {id:'gone',title:'Local only',image:{path:path.join(local,'secret.png'),mediaType:'image/png'},shots:[{image:{path:path.join(local,'notes.html'),mediaType:'text/html'}}]},
      {id:'other',title:'Another review\'s',image:{path:`/x/${id}/media/reviews/other-review/a.png`,mediaType:'image/png'}},
      {id:'fallback',title:'First shot stands in',image:{path:path.join(local,'secret.png'),mediaType:'image/png'},shots:[{image:theirs('a.png')},{image:theirs('still.png'),media:{...theirs('payload.bin'),mediaType:'video/mp4'}},{image:{...theirs('payload.bin'),width:99999,height:1}},{image:theirs('still.png'),media:{...theirs('clip.svg'),mediaType:'video/mp4'}},{image:theirs('still.png'),media:{...theirs('clip.pdf'),mediaType:'video/mp4'}},{image:theirs('still.html')}]},
    ],
    draft:{notes:{ok:'fine',gone:'gone too'},pickedIds:['ok','gone'],pickedId:'gone'}};
  const fitted=fitReview(raw,media)!;
  const here=(rest:string)=>path.join(final,'reviews',rid,...rest.split('/'));
  assert.deepEqual(fitted.options.map(o=>o.id),['ok','fallback'],'options with nothing that came go');
  const ok=fitted.options[0]!;
  assert.equal(ok.image.path,here('a.png'));
  assert.deepEqual(ok.shots!.map(s=>[s.image.path,s.media?.path]),[
    [here('a.png'),undefined],
    [here('still.png'),here('clip.mp4')],
    [here('still.png'),here('pagedir/index.html')],
    // Its video wasn't one that came: the still alone.
    [here('still.png'),undefined],
    // A page is a page, whatever it was called.
    [here('still.png'),here('payload.html')],
  ]);
  assert.deepEqual(ok.shots!.map(s=>s.media?.mediaType),[undefined,'video/mp4','text/html',undefined,'text/html']);
  // Neither a video nor a picture: its video goes, and the shot whose picture it was.
  assert.deepEqual(fitted.options[1]!.shots!.map(s=>[s.image.path,s.media?.path]),[[here('a.png'),undefined],[here('still.png'),undefined],[here('still.png'),undefined],[here('still.png'),undefined]]);
  assert.deepEqual([ok.image.mediaType,ok.image.width,ok.image.height],['image/png',12,8],'its type and size are the file\'s');
  assert.equal(ok.url,undefined,'Open live is for web pages only');
  assert.equal(fitted.options[1]!.image.path,here('a.png'));
  const every=JSON.stringify(fitted);
  assert.ok(!every.includes(local),every);
  assert.ok(!every.includes('/home/someone'),every);
  assert.equal(fitted.recommended,undefined);
  assert.deepEqual({...fitted.draft.notes},{ok:'fine'});
  assert.deepEqual(fitted.draft.pickedIds,['ok']);
  assert.equal(fitted.draft.pickedId,undefined);
  // A note's links but web pages are only words, and doing it again changes nothing.
  assert.equal(fitted.note,'See [the file]\\(/etc/passwd) or [the site](https://example.com/x) and \\[kept]\\(./x)');
  assert.equal(ok.note,'[open]\\(file:///Users/m/secret.png)');
  assert.deepEqual(fitReview(fitted,{threadId:id,now:final,final:final}) ?? 'gone','gone','the copies are where now will be, not there yet');
  fs.mkdirSync(path.dirname(final),{recursive:true});
  fs.renameSync(now,final);
  assert.deepEqual(fitReview(fitted,{threadId:id,now:final,final}),fitted,'again, once adopted');
  // The window's parser makes a link only from a ]( and takes the address
  // to the next parenthesis: none is left but before a web address alone.
  // The second is Codex's and Gemini's: a code span the parser ends inside a
  // web link's address.
  for (const note of ['[[x](https://a.b)](/etc/passwd)','`[x](https://example.test/`[open)](/Users/victim/private.md)','\\\\[x](/etc)','`a\\`[x](/etc)`','[a [b] c](/etc)','[x]( /etc )','[x](https://a.b/(y))','[x](https://a b)','[x](\nhttps://a.b)','[open](\uFEFFhttps://x/../../private.png)','[open](\u00A0https://x)','[open](https://x\u3000)','plain']) {
    const out=webLinksOnly(note);
    assert.equal(webLinksOnly(out),out,note);
    // Only ASCII spaces round the address, which Rust's trim takes too.
    for (let i=out.indexOf(']('); i>=0; i=out.indexOf('](',i+1)) assert.match(out.slice(i+1),/^\([ \t\r\n]*https?:\/\/[!-'*-~]*[ \t\r\n]*\)/i,out);
    assert.equal(out.replaceAll(']\\(','](') ,note.replaceAll(']\\(','](') ,'the words stay');
  }
  // A draft and response in shapes the runner works with (Gemini's third review).
  const here2={threadId:id,now:final,final};
  const shaped=fitReview({...raw,draft:null,response:{reply:'ok'}},here2)!;
  assert.deepEqual(shaped.draft,{notes:{}});
  assert.deepEqual(shaped.response,{reply:'ok',notes:{}});
  assert.equal(fitReview({...raw,response:'x'},here2)!.response,undefined);
  // A review with nothing that came isn't a review here.
  assert.equal(fitReview({...raw,options:[raw.options[1]]},media),undefined);
  fs.rmSync(root,{recursive:true,force:true});
});

// Daybreak 159: the moved log's review.updated events are the other runner's
// word too, and recoverReviews takes a later revision from the log.
test('a review recovered from the log keeps only this thread\'s own copies', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const secret=path.join(h.home,'secret.png');
  fs.writeFileSync(secret,makePng(10,10));
  const st=(h.runner as any).threads.get(thread.id);
  const log=h.store.log(thread.id);
  const evil={...review,revision:99,note:'[x](/etc/passwd)',options:review.options.map((o,i)=>i===0?{...o,image:{path:secret,mediaType:'image/png'},shots:undefined}:o)};
  log.append({seq:log.lastSeq+1,ts:new Date().toISOString(),type:'review.updated',review:evil} as any);
  const nothing={...review,id:'11111111-2222-4333-8444-555566667777',revision:5,options:[{...review.options[0],image:{path:secret,mediaType:'image/png'}}]};
  log.append({seq:log.lastSeq+1,ts:new Date().toISOString(),type:'review.updated',review:nothing} as any);
  h.runner.recoverReviews(st);
  const got=st.rec.reviews.find((r:any)=>r.id===review.id);
  assert.equal(got.revision,99,'the later revision is recovered');
  assert.deepEqual(got.options.map((o:any)=>o.id),['B','D'],'without the option naming a file of this Mac\'s');
  assert.ok(!JSON.stringify(st.rec.reviews).includes(secret));
  // Its words as they were: a log of this Mac's own (a moved one is fitted as it's placed).
  assert.equal(got.note,'[x](/etc/passwd)');
  assert.equal(st.rec.reviews.some((r:any)=>r.id===nothing.id),false,'one with nothing of its own is not recovered');
});

// Gemini's second review: a thread whose record is rebuilt from its log
// took each review.updated as it was.
test('a review rebuilt from the log keeps only this thread\'s own copies', () => {
  const {h,thread,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const secret=path.join(h.home,'secret.png');
  fs.writeFileSync(secret,makePng(10,10));
  const log=h.store.log(thread.id);
  const other={...review,id:'21111111-2222-4333-8444-555566667777',options:[{...review.options[0],image:{path:secret,mediaType:'image/png'}}]};
  log.append({seq:log.lastSeq+1,ts:new Date().toISOString(),type:'review.updated',review:other} as any);
  log.append({seq:log.lastSeq+1,ts:new Date().toISOString(),type:'review.updated',review:null} as any);
  const rec=h.runner.rebuild(thread.id)!;
  assert.deepEqual(rec.reviews!.map(r=>r.id),[review.id]);
  assert.ok(!JSON.stringify(rec.reviews).includes(secret));
});

test('a queued message only sends the thread\'s own pictures', async () => {
  const {h,thread,source,input}=fixture();
  const {review}=h.runner.createReview(thread.id,input);
  const pasted=h.runner.importMedia(source).image;
  const kept=h.runner.saveReview(thread.id,review.id,0,{notes:{},reply:'[Picture 1]',images:[pasted]}).review.draft.images![0];
  h.adapter.last.result(); await tick();
  const st=(h.runner as any).threads.get(thread.id);
  const media=h.store.mediaDir(thread.id);
  fs.mkdirSync(media,{recursive:true});
  const own=path.join(media,'own.png');
  fs.copyFileSync(source,own);
  const link=path.join(media,'link.png');
  fs.symlinkSync(source,link);
  const sentBefore=h.adapter.last.sent.length;
  st.rec.queue.push({turnId:'q-own',text:'look [Picture 1] [Picture 2] [Picture 3] [Picture 4]',images:[{path:source,mediaType:'image/png'},{path:own,mediaType:'image/png'},{path:link,mediaType:'image/png'},{path:kept.path,mediaType:'image/png'}]});
  h.runner.kickQueue(st);
  await tick();
  const sent=h.adapter.last.sent.slice(sentBefore).find((m:any)=>m.id==='q-own') as any;
  assert.ok(sent,'the message still goes');
  assert.deepEqual(sent.images.map((i:any)=>path.basename(i.path)),['own.png',path.basename(kept.path)]);
  const logged=h.runner.events(thread.id,{limit:1000}).events.find((e:any)=>e.type==='user.message'&&e.turnId==='q-own') as any;
  assert.equal(logged.images.length,2,'the transcript shows what went');
});

// Codex's review of that, 17 Nov: a retry after the session went re-sent a
// logged message's pictures unchecked; a list that isn't one stalled the
// queue for good; and a picture left out moved the next one onto its marker.
test('every send to the CLI checks its pictures, keeps the markers right, and a bad list never stalls the queue', async () => {
  const {h,thread,source}=fixture();
  h.adapter.last.result(); await tick();
  const st=(h.runner as any).threads.get(thread.id);
  const media=h.store.mediaDir(thread.id);
  fs.mkdirSync(media,{recursive:true});
  const own=path.join(media,'own.png');
  fs.copyFileSync(source,own);
  // Straight to the session, as the retry after a lost session sends.
  const before=h.adapter.last.sent.length;
  st.rt.session.send({id:'direct',text:'Before [Picture 1], after [Picture 2]',images:[{path:source,mediaType:'image/png'},{path:own,mediaType:'image/png'}]});
  const direct=h.adapter.last.sent[before] as any;
  assert.deepEqual(direct.images.map((i:any)=>path.basename(i.path)),['own.png']);
  assert.equal(direct.text,'Before [Picture 1 unavailable], after [Picture 1]');
  h.adapter.last.result(); await tick();
  // A queued message whose images aren't a list goes, with none.
  st.rec.queue.push({turnId:'q-bad',text:'hello',images:{}} as any);
  st.rec.queue.push({turnId:'q-next',text:'after it',images:[]});
  h.runner.kickQueue(st); await tick();
  const sent=h.adapter.last.sent.find((m:any)=>m.id==='q-bad') as any;
  assert.ok(sent,'it went rather than stalling');
  assert.deepEqual(sent.images,[]);
});

test('markers follow the pictures kept', () => {
  assert.equal(keepPictureMarkers('A [Picture 1], B [Picture 2], C [Picture 3] [Picture 9]',[false,true,true]),'A [Picture 1 unavailable], B [Picture 1], C [Picture 2] [Picture 9]');
  assert.equal(keepPictureMarkers('same [Picture 1]',[true]),'same [Picture 1]');
});

// Each option's note is read in the review window, under its pictures at
// reading size, so the agent is told not to write the options out again in
// its reply (Mike, 20 and 21 Nov).
test('show_options tells the agent not to repeat the options in its reply', async () => {
  const {h,thread,input}=fixture();
  const tool=buildThreadbearTools(h.runner,thread.id).find(t=>t.name==='show_options')!;
  // Typed as what the tool is handed, whichever tool the list's type says.
  const show=tool.handler as unknown as (options: object, extra: object)=>Promise<unknown>;
  const said=JSON.stringify(await show(input,{}));
  assert.match(said,/reads each option's note under its pictures in the review window/);
  assert.match(said,/don't list or describe the options again in your reply/);
  assert.match(said,/review:[0-9a-f-]{36}/);
});

// The review board (docs/protocol/events.md, "Marks: the canvas"):
// the agent's marks ride on shots, Mike's on the draft.
type Sent = { text: string; images: ImageRef[]; reviewResponse: ReviewDraft; reviewId?: string; type: string };
type Queued = Sent & { turnId: string };
const circle = { kind: 'circle', box: [0.1, 0.2, 0.3, 0.4], note: 'Too tight', ink: 'rose' };

test('canvas: agent marks are kept on their shots, an option\'s on its path shot, with shots kept for them', () => {
  const {h, thread, source, input} = fixture();
  const {review} = h.runner.createReview(thread.id, {...input, options: [
    {id: 'A', title: 'First', path: source, marks: [circle]},
    {id: 'B', title: 'Second', path: source, shots: [{path: source, title: 'Detail', marks: [{kind: 'arrow', box: [0.5, 0.5, 0.5, 0.5]}]}]},
    input.options[2],
  ]} as never);
  assert.deepEqual(review.options[0].shots, [{image: review.options[0].image, marks: [circle]}], 'one plain shot with marks still lists shots');
  assert.equal(review.options[1].shots![0].marks, undefined);
  assert.deepEqual(review.options[1].shots![1].marks, [{kind: 'arrow', box: [0.5, 0.5, 0.5, 0.5]}]);
  assert.equal(review.options[2].shots, undefined);
  // They survive a restart.
  assert.deepEqual(h.restart().runner.getReview(thread.id, review.id).review.options[0].shots![0].marks, [circle]);
});

test('canvas: agent marks are checked, with limits of 6 a picture and 30 a review', () => {
  const {h, thread, source, input} = fixture();
  const make = (marks: unknown, extra: Record<string, unknown> = {}) => h.runner.createReview(thread.id, {...input, options: [{id: 'A', title: 'First', path: source, marks, ...extra}]} as never);
  assert.throws(() => make([{...circle, box: [0.4, 0, 0.2, 1]}]), /marks\[0\] on A, picture 1: box must be \[x0, y0, x1, y1\].*x0 <= x1/);
  assert.throws(() => make([{...circle, box: [0, 0, 1.2, 1]}]), /box must be/);
  assert.throws(() => make([{...circle, box: [0, 0, 1]}]), /box must be/);
  assert.throws(() => make([{...circle, kind: 'star'}]), /kind must be circle, underline, highlight or arrow/);
  assert.throws(() => make([{...circle, ink: 'blue'}]), /ink must be yellow, green or rose/);
  assert.throws(() => make([{...circle, note: 'x'.repeat(81)}]), /note must be text of at most 80 characters/);
  assert.throws(() => make(Array(7).fill(circle)), /A, picture 1 has 7 marks; at most 6 a picture/);
  assert.throws(() => make('x'), /marks on A, picture 1 must be a list/);
  assert.throws(() => h.runner.createReview(thread.id, {...input, options: [{id: 'A', title: 'First', shots: [{path: source}], marks: [circle]}]} as never), /belong to its path picture/);
  const six = Array(6).fill(circle);
  const options = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => ({id, title: id, path: source, marks: six}));
  assert.throws(() => h.runner.createReview(thread.id, {...input, options} as never), /at most 30 marks in all; this has 36/);
  assert.equal(h.runner.get(thread.id).pendingReviews, undefined, 'no card from a bad one');
});

test('canvas: show_options offers marks on options and shots without experiment configuration', () => {
  const {h, thread} = fixture();
  const t = buildThreadbearTools(h.runner, thread.id).find(x => x.name === 'show_options')! as unknown as { inputSchema: { options: { element: { shape: Record<string, unknown> & { shots: { unwrap: () => { element: { shape: Record<string, unknown> } } } } } } } };
  assert.ok(t.inputSchema.options.element.shape.marks);
  assert.ok(t.inputSchema.options.element.shape.shots.unwrap().element.shape.marks);
});

test('canvas: Mike\'s marks are checked against the review\'s options and shots', () => {
  const {h, thread, input} = fixture();
  const {review} = h.runner.createReview(thread.id, input);
  const mark = {n: 1, kind: 'circle', optionId: 'A', shot: 0, box: [0.36, 0.83, 0.5, 0.92]};
  const save = (marks: unknown) => h.runner.saveReview(thread.id, review.id, 0, {notes: {}, marks} as never);
  assert.throws(() => save([{...mark, optionId: 'Z'}]), /marks\[0\]: unknown option: Z/);
  assert.throws(() => save([{...mark, optionId: 'D'}]), /reference option/);
  assert.throws(() => save([{...mark, shot: 1}]), /A has no picture 2; shot is 0-based, below 1/);
  assert.throws(() => save([{...mark, kind: 'arrow'}]), /kind must be circle, highlight or pin/);
  assert.throws(() => save([{...mark, n: 0}]), /n must be a whole number from 1/);
  assert.throws(() => save([mark, mark]), /Two marks are numbered 1/);
  assert.throws(() => save([{...mark, box: [0.5, 0, 0.4, 1]}]), /box must be/);
  assert.throws(() => save([{...mark, path: Array(401).fill([0.1, 0.1])}]), /at most 400 \[x, y\] points/);
  assert.throws(() => save(Array.from({length: 21}, (_, i) => ({...mark, n: i + 1}))), /at most 20 marks; this has 21/);
  assert.throws(() => save([{...mark, image: {path: ''}}]), /image must be a picture with a path/);
  // A stroke past the edge is kept on the picture.
  const saved = save([{...mark, n: 2, path: [[-0.1, 0.5], [0.4, 1.2]]}, mark]).review;
  assert.deepEqual(saved.draft.marks!.map(m => m.n), [1, 2], 'in number order');
  assert.deepEqual(saved.draft.marks![1].path, [[0, 0.5], [0.4, 1]]);
});

test('canvas: Mike\'s marks are kept through save and respond, alone are an answer, and go to the agent as lines and cut-outs', async () => {
  const {h, thread, source, input} = fixture();
  const {review} = h.runner.createReview(thread.id, {...input, options: [input.options[0], {id: 'B', title: 'Second', path: source, shots: [{path: source, title: 'Detail'}]}, input.options[2]]});
  const pasted = h.runner.importMedia(source).image;
  const cut = h.runner.importMedia(path.join(h.home, 'mockup.png')).image;
  const marks = [
    {n: 1, kind: 'circle', optionId: 'B', shot: 1, box: [0.361, 0.83, 0.5, 0.92], path: [[0.4, 0.83], [0.5, 0.9]], image: cut},
    {n: 2, kind: 'pin', optionId: 'A', shot: 0, box: [0.4, 0.2, 0.4, 0.2], path: [[0.4, 0.2]]},
  ];
  const saved = h.runner.saveReview(thread.id, review.id, 0, {notes: {}, reply: 'Look [Mark 1] [Picture 1]', images: [pasted], marks} as never).review;
  const kept = saved.draft.marks![0].image!;
  assert.match(kept.path, new RegExp(`reviews[\\\\/]${review.id}[\\\\/]reply[\\\\/]`), 'the cut-out is kept as reply pictures are');
  assert.equal(saved.draft.marks![1].image, undefined);
  // A cut-out from anywhere but inbox/ or the review is refused.
  assert.throws(() => h.runner.saveReview(thread.id, review.id, saved.revision, {notes: {}, marks: [{...marks[0], image: {path: source, mediaType: 'image/png'}}]} as never), /media.import/);
  // A client that doesn't draw marks keeps the saved ones; marks: [] takes them away.
  const {marks: _marks, ...withoutMarks} = saved.draft;
  const older = h.runner.saveReview(thread.id, review.id, saved.revision, withoutMarks).review;
  assert.deepEqual(older.draft.marks, saved.draft.marks);
  const plain = h.runner.saveReview(thread.id, review.id, older.revision, {notes: {}} as never).review;
  assert.deepEqual(plain.draft.marks, saved.draft.marks);
  assert.equal(h.runner.saveReview(thread.id, review.id, plain.revision, {notes: {}, marks: []} as never).review.draft.marks, undefined);
  // A mark alone is an answer, and a retry naming the inbox copy is the same one.
  const second = h.runner.createReview(thread.id, input).review;
  const alone = {notes: {}, marks: [{n: 1, kind: 'highlight', optionId: 'A', shot: 0, box: [0, 0, 1, 0.5], image: cut}]};
  const sent = h.runner.respondReview(thread.id, second.id, 0, alone as never);
  assert.deepEqual(h.runner.respondReview(thread.id, second.id, 0, alone as never), sent);
  assert.throws(() => h.runner.respondReview(thread.id, second.id, 0, {...alone, marks: [{...alone.marks[0], box: [0, 0, 1, 0.6]}]} as never), /answered/);
  // The full answer.
  const current = h.runner.getReview(thread.id, review.id).review;
  const answered = h.runner.respondReview(thread.id, review.id, current.revision, {pickedId: 'A', notes: {B: 'Busy'}, reply: 'Look [Mark 1] [Picture 1]', images: [pasted], marks} as never);
  assert.deepEqual(answered.review.response!.marks!.map(m => m.n), [1, 2]);
  for (let i = 0; i < 3; i++) { h.adapter.last.result(); await tick(); }
  const message = h.runner.events(thread.id, {limit: 1000}).events.find(e => e.type === 'user.message' && e.reviewId === review.id) as unknown as Sent;
  assert.ok(message, 'the answer went to the agent');
  assert.equal(message.text.split('\n\n').slice(1, 5).join('\n\n'), [
    'Picked A. First.',
    'Look [Mark 1] [Picture 1]',
    '[Mark 1] circle on B. Second, picture 2 (Detail), across 36-50% and down 83-92% of it.\n[Mark 2] pin on A. First, picture 1, across 40% and down 20% of it.',
    'Notes on B (Second): Busy',
  ].join('\n\n'));
  assert.equal(message.images.length, 2, 'the reply\'s picture, then the cut-out');
  assert.equal(message.images[1].path, kept.path);
  assert.deepEqual(message.reviewResponse.marks!.map(m => m.n), [1, 2]);
  const alonely = h.runner.events(thread.id, {limit: 1000}).events.find(e => e.type === 'user.message' && e.reviewId === second.id) as unknown as Sent;
  assert.match(alonely.text, /\n\n\[Mark 1\] highlight on A\. First, picture 1, across 0-100% and down 0-50% of it\.$/);
  assert.equal(alonely.images.length, 1);
});

test('canvas: a moved review keeps marks that fit and none of its cut-outs; recovery keeps only its own', () => {
  const {h, thread, source, input} = fixture();
  const {review} = h.runner.createReview(thread.id, {...input, options: [{id: 'A', title: 'First', path: source, marks: [circle]}, input.options[1], input.options[2]]} as never);
  const own = {threadId: thread.id, now: h.store.mediaDir(thread.id), final: h.store.mediaDir(thread.id)};
  const outside = {path: '/etc/hosts', mediaType: 'image/png'};
  const shots = [{...review.options[0].shots![0], marks: [{...circle, note: 'y'.repeat(200)}, {kind: 'bad', box: [0, 0, 1, 1]}, ...Array(8).fill(circle)]}];
  const draftMarks = [{n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0], image: outside}, {n: 2, kind: 'pin', optionId: 'D', shot: 0, box: [0, 0, 0, 0]}, {n: 3, kind: 'pin', optionId: 'A', shot: 5, box: [0, 0, 0, 0]}];
  const moved = fitReview({...review, options: [{...review.options[0], shots}, ...review.options.slice(1)], draft: {notes: {}, marks: draftMarks}}, own)!;
  const fitted = moved.options[0].shots![0].marks!;
  assert.equal(fitted.length, 6);
  assert.equal(fitted[0].note, 'y'.repeat(80));
  assert.deepEqual(moved.draft.marks, [{n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0]}], 'only marks on real pictures, with no cut-out');
  // Recovered from its own log: a cut-out that isn't the review's own goes, the mark stays.
  const st = (h.runner as unknown as { threads: Map<string, Parameters<typeof h.runner.ownReplyImages>[0]> }).threads.get(thread.id)!;
  const ownMarks = h.runner.ownReplyImages(st, {...review, draft: {notes: {}, marks: [draftMarks[0]] as never}});
  assert.deepEqual(ownMarks.draft.marks, [{n: 1, kind: 'pin', optionId: 'A', shot: 0, box: [0, 0, 0, 0]}]);
  st.rec.queue.push({turnId: 't-m', text: 'x', images: [outside], reviewId: review.id, reviewResponse: {notes: {}, marks: [draftMarks[0]]}} as never);
  h.runner.recoverReviews(st);
  const queued = st.rec.queue.find(q => q.turnId === 't-m') as Queued;
  assert.deepEqual(queued.images, []);
  assert.equal(queued.reviewResponse.marks![0].image, undefined);
});


test('HTML imports and moved reviews keep the full 10 MiB offline page limit', (t) => {
  t.mock.method(stills, 'quickLook', () => undefined);
  const { h, thread } = fixture();
  const page = path.join(h.home, 'large.html');
  const bytes = Buffer.alloc(10 * 1024 * 1024, ' ');
  bytes.write('<!doctype html><meta charset="utf-8"><button>Try it</button>');
  fs.writeFileSync(page, bytes);
  const { review } = h.runner.createReview(thread.id, {title: 'Large offline page', options: [{id: 'A', title: 'Full page', path: page}]});
  const media = review.options[0]!.shots![0]!.media!;
  assert.equal(fs.statSync(media.path).size, bytes.length);
  const root = h.store.mediaDir(thread.id);
  const moved = fitReview(review, {threadId: thread.id, now: root, final: root})!;
  assert.equal(moved.options[0]!.shots![0]!.media?.path, media.path);
  fs.appendFileSync(page, 'x');
  assert.throws(() => h.runner.createReview(thread.id, {title: 'Too large', options: [{id: 'A', title: 'Oversize', path: page}]}), /at most 10 MB/);
  fs.appendFileSync(media.path, Buffer.alloc(1025));
  assert.equal(fitReview(review, {threadId: thread.id, now: root, final: root})!.options[0]!.shots![0]!.media, undefined);
});
