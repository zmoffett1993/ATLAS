const test = require('node:test');
const assert = require('node:assert/strict');
const pod = require('../atlas-routing-pod-core.js');

test('POD names use the exact sales order convention without losing leading zeroes', () => {
  for (const value of ['68032', 'SO-68032', 'SO-US-68032', 'so us 68032', '  SO  US  68032  ']) {
    assert.deepEqual(pod.naming(value), {salesOrderNumber:'68032',basename:'POD-SO-68032',filename:'POD-SO-68032.pdf',subject:'POD-SO-68032',shipmentLabel:'Shipment 1 of 1'});
  }
  assert.equal(pod.naming('SO-US-0068032').filename, 'POD-SO-0068032.pdf');
});
test('malformed and hostile sales order values cannot become filenames or email headers', () => {
  for(const value of [null,68032,'','SO-SO-68032','POD-SO-68032','INV-68032','SO-US-','SO-US-68032/1','../68032','68032.pdf','68032\r\nBcc:other@example.test','68032\0','68 032','SO--68032','１２３','1'.repeat(21)]) {
    assert.throws(()=>pod.naming(value),{code:'INVALID_SALES_ORDER'});
  }
});
test('split shipment filenames and subjects have distinct, exact suffixes', () => {
  assert.equal(pod.naming('SO-US-68032',1,2).filename,'POD-SO-68032-SHIPMENT-1-OF-2.pdf');
  assert.equal(pod.naming('68032',2,2).subject,'POD-SO-68032-SHIPMENT-2-OF-2');
  for(const pair of [[0,2],[3,2],[1,0],[1.5,2],['1',2],[1,null],[1,Infinity]])assert.throws(()=>pod.naming('68032',...pair),{code:'INVALID_SHIPMENT'});
});
test('a queued upload or assumed delivery never claims server receipt or closes a stop', () => {
  const queued=pod.status({delivery:'delivered',queue:'queued_offline'});
  assert.equal(queued.label,'POD SAVED — WAITING FOR CONNECTION');assert.equal(queued.fullyClosed,false);
  const assumed=pod.status({delivery:'assumed'});assert.equal(assumed.label,'ASSUMED DELIVERED — POD PENDING');assert.equal(assumed.documentationComplete,false);
  assert.equal(pod.status({delivery:'assumed',serverReceived:true}).fullyClosed,false);
  assert.equal(pod.status({delivery:'delivered',queue:'uploading'}).label,'POD UPLOADING');
  assert.throws(()=>pod.status({email:'accepted'}),{code:'INVALID_STATUS'});
});
test('email failure never loses server receipt and provider acceptance is Sent, not Delivered', () => {
  const failed=pod.status({delivery:'delivered',serverReceived:true,email:'failed'});
  assert.equal(failed.label,'POD SAVED — EMAIL NOT SENT');assert.equal(failed.documentationComplete,true);assert.equal(failed.fullyClosed,true);
  assert.equal(pod.status({serverReceived:true,email:'accepted'}).emailLabel,'Sent');
  assert.equal(pod.status({serverReceived:true,email:'delivered'}).emailLabel,'Delivered');
  assert.equal(pod.status({serverReceived:true,email:'bounced'}).tone,'warning');
});
test('only explicit, typed exception state can satisfy missing documentation', () => {
  assert.equal(pod.status({delivery:'delivered',exceptionApproved:true}).fullyClosed,true);
  assert.throws(()=>pod.status({exceptionApproved:'true'}),{code:'INVALID_STATUS'});
  assert.throws(()=>pod.status({queue:'complete'}),{code:'INVALID_STATUS'});
});
test('submission identifiers normalize a stable retry identity and reject invalid values', () => {
  const id='AABBCCDD-1111-4222-8333-123456789ABC';assert.equal(pod.submissionId(id),id.toLowerCase());
  assert.throws(()=>pod.submissionId('68032'),{code:'INVALID_SUBMISSION_ID'});
  assert.throws(()=>pod.submissionId('00000000-0000-0000-0000-000000000000'),{code:'INVALID_SUBMISSION_ID'});
});
test('quality review preserves warning codes and requires an explicit override', () => {
  assert.deepEqual(pod.qualityReview(['blur','blur','glare']),{warnings:['blur','glare'],overrideUsed:false,needsReview:true});
  assert.equal(pod.qualityReview(['dark'],true).overrideUsed,true);
  assert.equal(pod.qualityReview([],true).overrideUsed,false);
  assert.throws(()=>pod.qualityReview(['unknown']),{code:'INVALID_QUALITY_REVIEW'});
});
test('retry delay grows with bounded jitter and never exceeds five minutes', () => {
  assert.equal(pod.retryDelay(0,()=>0),1500);
  assert.ok(pod.retryDelay(5,()=>0.5)>pod.retryDelay(0,()=>0.5));
  assert.ok(pod.retryDelay(Number.MAX_SAFE_INTEGER,()=>0.999)<300001);
  assert.throws(()=>pod.retryDelay(-1),{code:'INVALID_RETRY'});
  assert.throws(()=>pod.retryDelay(1,()=>1),{code:'INVALID_RETRY'});
});
