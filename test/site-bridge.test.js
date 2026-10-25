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
