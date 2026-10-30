// Task-only synthetic characterization, not an authenticated two-person Gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCoreCodingTools } from '../../src/agents/core-coding-tools.js';
import { filterBootstrapFilesForSession } from '../../src/agents/workspace.js';
import { withGatewayToolCallerIdentity } from '../../src/agents/tools/gateway-caller-context.js';
const root = path.resolve('.openclaw/tmp/issue-186068/fixture');
for (const person of ['alice','bob']) {
  await fs.mkdir(path.join(root,'users',person), {recursive:true});
  await fs.writeFile(path.join(root,'users',person,'USER.md'), person.toUpperCase()+'_SYNTHETIC_PRIVATE');
}
const tools = createCoreCodingTools({ codingRoot:root, containmentRoot:root, includeBaseCodingTools:true,
  shellTools:'disabled', workspaceOnly:true, readOnly:true, applyPatchEnabled:false,
  applyPatchWorkspaceOnly:true, execDefaults:{}, processDefaults:{} });
const read = tools.find(t => t.name==='read');
assert.ok(read);
const results = await withGatewayToolCallerIdentity({agentId:'main',sessionKey:'agent:main:fixture',receiptAuthority:()=>true}, async () => {
  const out = [];
  for (const person of ['alice','bob']) {
    const result = await read.execute('synthetic-read-'+person,{path:'users/'+person+'/USER.md'});
    assert.ok(JSON.stringify(result).includes(person.toUpperCase()+'_SYNTHETIC_PRIVATE'));
    out.push({file:person,readable:true});
  }
  return out;
});
const selected = [
  {name:'USER.md',path:path.join(root,'USER.md'),content:'Shared defaults',missing:false},
  {name:'USER.md',path:path.join(root,'users','alice','USER.md'),content:'ALICE_SYNTHETIC_PRIVATE',missing:false,personalUser:true},
];
const group = filterBootstrapFilesForSession(selected,{workspaceDir:root,sessionKey:'agent:main:discord:group:synthetic',chatType:'group'});
assert.equal(group.length,2);
const report = {proofLevel:'production-tool and bootstrap-filter characterization, NOT authenticated two-person Gateway or model E2E',workspaceOnlyRead:results,groupRetainsAlreadySelectedPersonalOverlay:group.some(f=>f.personalUser),participantProfilesConcatenated:false};
await fs.writeFile('.openclaw/tmp/issue-186068/characterization.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
