import { describe, expect, it, vi } from 'vitest';
import { KagiClient } from '../../lib/kagi/client.js';
import { formatOutput, MAX_OUTPUT_BYTES } from '../../lib/kagi/output.js';
const card=(n:number)=>`<div class="search-result"><a class="__sri_title_link" href="https://e.test/${n}">Title ${n}</a><div class="__sri-desc">Evidence</div></div>`;
const next='<a id="load_more_results" class="btn --secondary --block" href="/html/search?q=x&amp;batch=2">More Results</a>';
const response=(text:string)=>new Response(text,{headers:{'content-type':'text/html'}});
describe('review regressions',()=>{
 it('retries a retained pagination cursor after query markup cooldown expires',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response(card(1)+next)).mockResolvedValueOnce(response('<p>unknown</p>')).mockResolvedValueOnce(response(card(2)));
  const client=new KagiClient({credential:async()=>'test-credential',fetcher,spacingMs:0,markupCooldownMs:10});
  expect((await client.search({query:'x',limit:2})).resultCount).toBe(1);
  await new Promise(resolve=>setTimeout(resolve,15));
  expect((await client.search({query:'x',limit:2})).resultCount).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it('reports the same retained count across cache-backed limit changes',async()=>{
  const fetcher=vi.fn().mockResolvedValue(response(Array.from({length:20},(_,i)=>card(i)).join('')));
  const client=new KagiClient({credential:async()=>'synthetic-test',fetcher,spacingMs:0});
  expect(await client.search({query:'x',limit:5})).toMatchObject({retrievedCount:20,resultCount:5});
  expect(await client.search({query:'x',limit:20})).toMatchObject({retrievedCount:20,resultCount:20,cached:true});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('recovers from oversized serialized URLs through the real parser and client',async()=>{
  const html=`<div class="search-result"><a class="__sri_title_link" href="https://e.test/${'界'.repeat(1400)}">Large URL</a></div>`+card(2);
  const client=new KagiClient({credential:async()=>'synthetic-test',fetcher:vi.fn().mockResolvedValue(response(html)),spacingMs:0});
  expect(await client.search({query:'x',limit:1})).toMatchObject({retrievedCount:2,resultCount:1,omittedCount:1,truncated:true});
 });
 it('counts all retrieved records without treating an explicit smaller limit as clipping',()=>{
  const rows=Array.from({length:20},(_,i)=>({rank:i+1,title:'Title',url:`https://e.test/${i}`,snippet:'',excerptClipped:false}));
  expect(formatOutput(rows,5,{retrievalComplete:true,pagesFetched:1,rejectedCount:0})).toMatchObject({resultCount:5,retrievedCount:20,omittedCount:0,truncated:false});
 });
 it('uses later useful records when the first record cannot fit even at limit one',()=>{
  const rows=[{rank:1,title:'Title',url:new URL('https://e.test/'+'界'.repeat(1400)).href,snippet:'',excerptClipped:false},{rank:2,title:'Useful',url:'https://e.test/useful',snippet:'',excerptClipped:false}];
  expect(formatOutput(rows,1,{retrievalComplete:true,pagesFetched:1,rejectedCount:0})).toMatchObject({resultCount:1,retrievedCount:2,omittedCount:1,truncated:true});
 });
 it('returns a full exact-fit set without temporary prefix omission overhead',()=>{
  const rows=[{rank:1,title:'x'.repeat(4096),url:'https://e.test/'+'x'.repeat(1500),snippet:'',excerptClipped:false},{rank:2,title:'x'.repeat(4096),url:'https://e.test/',snippet:'',excerptClipped:false},{rank:3,title:'x',url:'https://e.test/',snippet:'',excerptClipped:false}];
  const status={retrievalComplete:true,pagesFetched:1,rejectedCount:0};
  const padding=MAX_OUTPUT_BYTES-Buffer.byteLength(formatOutput(rows,3,status).text);
  const padded=rows.map((row,index)=>index===1?{...row,url:row.url+'x'.repeat(padding)}:row);
  const result=formatOutput(padded,3,status);
  expect(result.resultCount).toBe(3);expect(Buffer.byteLength(result.text)).toBe(MAX_OUTPUT_BYTES);
 });
 it('shortens snippets before dropping requested result records',()=>{
  const results=Array.from({length:20},(_,i)=>({rank:i+1,title:'Complete useful title',url:`https://example.com/${i}`,snippet:'x'.repeat(600),excerptClipped:false}));
  const output=formatOutput(results,20,{retrievalComplete:true,pagesFetched:1,rejectedCount:0});
  expect(output.resultCount).toBe(20);expect(output.excerptClippedCount).toBe(20);
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
 });
});
