/** Exercise the next real SDK request, not a guessed context filter. No network or account files. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
const scratch=mkdtempSync(join(tmpdir(),"cc-context-"));
process.env.HOME=scratch;
process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
process.env.PI_OFFLINE="1";
const sdk=await import(pathToFileURL(join(agentRoot,"dist/bundle/index.js")).href);
const ai=await import(pathToFileURL(join(agentRoot,"node_modules/@earendil-works/pi-ai/dist/index.js")).href);
test("end-of-turn custom entry renders but never reaches the next request or restored context",async t=>{
 const calls:any[][]=[];
 const runtime=await sdk.ModelRuntime.create({credentials:new ai.InMemoryCredentialStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
 runtime.registerProvider("fixture",{api:"openai-completions",apiKey:"synthetic-not-a-credential",baseUrl:"http://127.0.0.1:1",models:[{id:"model",name:"model",reasoning:true,input:["text"],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
 streamSimple(model:any,context:any){
  calls.push(structuredClone(context.messages));
  const stream=new ai.AssistantMessageEventStream();
  const message={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"text",text:"Actual answer."}],stopReason:"stop",timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  stream.push({type:"done",reason:"stop",message});stream.end();return stream;
 }});
 const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},cacheWarming:"off"});
 const loader=new sdk.DefaultResourceLoader({cwd:scratch,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[fileURLToPath(new URL("../extensions/phase-spinner.ts",import.meta.url))]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const manager=sdk.SessionManager.inMemory(scratch);
 const {session}=await sdk.createAgentSession({cwd:scratch,agentDir:process.env.PI_CODING_AGENT_DIR,modelRuntime:runtime,model:runtime.getModel("fixture","model"),settingsManager,resourceLoader:loader,sessionManager:manager,noTools:"all"});
 t.after(async()=>{await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});session.dispose();rmSync(scratch,{recursive:true,force:true});});
 const errors:unknown[]=[];
 await session.bindExtensions({mode:"tui",onError:(error:unknown)=>errors.push(error)});
 await session.prompt("First request.");
 const entries=manager.getBranch().filter((entry:any)=>entry.type==="custom"&&entry.customType==="pi-extras.run-end");
 assert.equal(entries.length,1,"one persisted display-only end entry");
 assert.equal(typeof entries[0].data.past,"string");
 await session.prompt("Second request.");
 assert.deepEqual(errors,[]);
 assert.equal(calls.length,2);
 assert.ok(JSON.stringify(calls[1]).includes("Actual answer."));
 assert.ok(!JSON.stringify(calls[1]).includes(entries[0].data.past));
 assert.doesNotMatch(JSON.stringify(calls[1]),/doneAt|run-end|done \d|Thought for/);
 assert.doesNotMatch(JSON.stringify(manager.buildSessionContext().messages),/doneAt|run-end|done \d|Thought for/);
});
