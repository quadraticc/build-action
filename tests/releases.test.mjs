import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBuild, prepare} from '../build/build.js';
import {run} from '../build/action.js';
import {values,env,buildID,acknowledgement} from './fixtures.mjs';

test('registration sends release opt-in and verifies it before publishing outputs',async()=>{
  const input={...values,'is-release':'true'};
  const result=await createBuild(input,env,async(_url,_token,body)=>{
    const payload=JSON.parse(body);assert.equal(payload.is_release,true);return acknowledgement(payload);
  });
  assert.equal(result.isRelease,true);
  for(const is_release of [undefined,false,'true']) {
    await assert.rejects(createBuild(input,env,async(_url,_token,body)=>acknowledgement(JSON.parse(body),201,{is_release})),/acknowledgement/);
  }
  for(const value of ['yes','TRUE',' true']) assert.throws(()=>prepare({...values,'is-release':value},env),/is-release/);
});

test('numbered replay preserves a release even when registration did not request promotion',async()=>{
  const result=await createBuild(values,env,async(_url,_token,body)=>acknowledgement(JSON.parse(body),200,{is_release:true}));
  assert.equal(result.isRelease,true);assert.equal(result.created,false);
});

const promote={...values,'version-prefix':'',images:'','build-id':buildID,'is-release':'true'};
const artifact={id:buildID,version:'1.2.3',commit_sha:'c'.repeat(40),branch:'original',images:{},metadata:{migration_name:'initial'},is_release:true,created_at:'2026-10-20T00:00:00Z'};
const reply=(changes={})=>({status:200,contentType:'application/json',body:JSON.stringify({...artifact,...changes})});

test('existing-build mode promotes by UUID in one POST and returns original artifact outputs',async()=>{
  let calls=0;
  const result=await createBuild(promote,env,async(url,token,body)=>{
    calls++;assert.ok(url.pathname.endsWith(`/builds/${buildID}/release`));assert.equal(token,values.token);assert.equal(body,'{}');return reply();
  });
  assert.equal(calls,1);assert.equal(result.id,buildID);assert.equal(result.created,false);assert.equal(result.isRelease,true);assert.equal(result.commit,artifact.commit_sha);assert.equal(result.branch,'original');assert.deepEqual(result.metadata,artifact.metadata);
});

test('promotion rejects mixed modes, malformed acknowledgements and redirects without retrying',async()=>{
  for(const change of [{'is-release':'false'},{version:'1.2.3'}, {'version-prefix':'0.0.'}, {images:'{}'}, {metadata:'{}'}, {'link-workflow-run':'true'},{'build-id':'bad'}]) {
    let calls=0;await assert.rejects(createBuild({...promote,...change},env,async()=>{calls++;return reply();}));assert.equal(calls,0);
  }
  for(const response of [reply({id:'44444444-4444-4444-4444-444444444444'}),reply({is_release:false}),reply({commit_sha:'bad'}),reply({version:'bad'}),reply({metadata:{token:123}}),{...reply(),status:302},{...reply(),contentType:'text/html'},{...reply(),body:'null'}]) {
    let calls=0;await assert.rejects(createBuild(promote,env,async()=>{calls++;return response;}));assert.equal(calls,1);
  }
});

test('action exposes confirmed release status only after a successful promotion',async()=>{
 const outputs=new Map(),errors=[];
 const toolkit={getInput:name=>promote[name]??'',setSecret:()=>{},setOutput:(k,v)=>outputs.set(k,v),setFailed:m=>errors.push(m),info:()=>{}};
 await run(toolkit,env,async()=>reply());assert.deepEqual(errors,[]);assert.equal(outputs.get('is-release'),'true');assert.equal(outputs.get('created'),'false');
});
