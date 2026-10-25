import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import { SiteBridge, bridgeSignature } from '../site-bridge.js';

test('bridge signs exact method, path, timestamp and bytes; refuses insecure origins', () => {
  assert.equal(bridgeSignature('secret','123','POST','/api/bridge/sync','{}'), createHmac('sha256','secret').update('123\nPOST\n/api/bridge/sync\n{}').digest('hex'));
  assert.throws(() => new SiteBridge({url:'http://example.org',database:new Database(':memory:')}), /HTTPS/);
});
test('bridge records delivery per recipient, retries failure and acknowledges durable delivery after restart', async () => {
  const database = new Database(':memory:');
  const event = {eventId:'event1',id:'00000000-0000-0000-0000-000000000001',kind:'new_request',reference:'TEST',productName:'Test',quantity:1,estimateRub:1,customer:{contact:'test@example.invalid',note:'test'}};
  const sent = [], calls = [];
  let fail = true;
  const options = {url:'https://example.org',key:'secret',database,adminIds:()=>['1','2'],isAdmin:id=>id===1,logger:{warn(){}},
    telegram:{sendMessage:async id=>{if(id==='2'&&fail)throw Error('offline');sent.push(id)}},
    fetchImpl:async(url,opts)=>{calls.push(JSON.parse(opts.body));return Response.json({events:[event]})}};
  const bridge = new SiteBridge(options);
  await bridge.sync();
  assert.deepEqual(sent,['1']);
  fail=false;
  await bridge.sync();
  assert.deepEqual(sent,['1','2']);
  const restarted = new SiteBridge(options);
  await restarted.sync(); await restarted.sync();
  assert.deepEqual(sent,['1','2']);
  assert.deepEqual(calls.at(-1).acknowledged,['event1']);
  database.close();
});
test('customer update is sent only after Telegram opt-in', async () => {
  const database = new Database(':memory:'); const sent=[];
  const bridge = new SiteBridge({url:'https://example.org',key:'secret',database,adminIds:()=>['1'],isAdmin:()=>true,
    telegram:{sendMessage:async(...args)=>sent.push(args)},fetchImpl:async()=>Response.json({events:[
      {eventId:'e1',id:'00000000-0000-0000-0000-000000000001',kind:'customer_update',state:'in_review'},
      {eventId:'e2',id:'00000000-0000-0000-0000-000000000002',kind:'customer_update',state:'offer_ready',telegramUserId:'123',reply:{text:'answer'}}
    ]})});
  await bridge.sync(); assert.equal(sent.length,1);assert.equal(sent[0][0],'123');assert.match(sent[0][1],/answer/);database.close();
});

test('website owner actions reject other users and owner replies bypass unrelated shop text states', async () => {
  const database=new Database(':memory:');const handlers={},calls=[],messages=[];
  const bridge=new SiteBridge({url:'https://example.org',key:'secret',database,telegram:{},adminIds:()=>['42'],isAdmin:id=>id===42});
  const fakeBot={start:fn=>handlers.start=fn,command:()=>{},action:(pattern,fn)=>handlers.action=fn,use:fn=>handlers.text=fn};
  bridge.call=async(path,payload)=>{calls.push(payload);return {ok:true,state:'offer_ready'}};
  bridge.register(fakeBot);
  const id='00000000-0000-0000-0000-000000000001';
  const context={from:{id:7},chat:{type:'private'},match:['','reply',id],answerCbQuery:async()=>{},reply:async text=>messages.push(text)};
  await handlers.action(context);assert.equal(bridge.pendingReply.size,0);assert.equal(calls.length,0);
  context.from.id=42;await handlers.action(context);assert.equal(bridge.pendingReply.size,1);
  let next=false;context.message={text:'Reply from owner'};await handlers.text(context,()=>{next=true});
  assert.equal(next,false);assert.deepEqual(calls,[{action:'reply',id,reply:'Reply from owner'}]);assert.equal(bridge.pendingReply.size,0);
  database.close();
});
test('Telegram linking requires a private chat and uses the actual sender ID', async () => {
  const database=new Database(':memory:');const handlers={},calls=[];
  const bridge=new SiteBridge({url:'https://example.org',key:'secret',database,telegram:{},adminIds:()=>['42'],isAdmin:()=>false});
  bridge.call=async(path,payload)=>{calls.push(payload);return {request:{id:'request',reference:'TEST',state:'new'}}};
  bridge.register({start:fn=>handlers.start=fn,command:()=>{},action:()=>{},use:()=>{}});
  const context={from:{id:123},chat:{type:'group'},startPayload:'site_'+'a'.repeat(32),reply:async()=>{}};
  await handlers.start(context,()=>{});assert.equal(calls.length,0);
  context.chat.type='private';await handlers.start(context,()=>{});
  assert.deepEqual(calls,[{action:'link',token:'a'.repeat(32),telegramUserId:'123'}]);database.close();
});
