import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/replyDiversity.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
const {replyOpening,repeatedOpening}=exports;

test('opening repetition covers the reported gift/chat pair and punctuation or interjection variants',()=>{
  const recent=[replyOpening('哎呀阿豪这五朵玫瑰一送过来，直播间都香起来啦，谢谢你的心意呀。','阿豪')];
  for(const text of ['哎呀，怎么啦，这是来聊天？','“哎呦！这是来聊天？','哎哟，怎么来打听八卦了？','哎，姐姐的感情生活是秘密。']) assert.ok(repeatedOpening(text,'小宇',recent),text);
  assert.ok(repeatedOpening('哈哈哈哈，欢迎回来。','小宇',[replyOpening('哈哈，谢谢你的礼物。')]));
  assert.ok(repeatedOpening('哇哦，这个问题真有意思。','小宇',[replyOpening('哇，五朵玫瑰真香。')]));
});

test('nickname changes cannot disguise a repeated template, while different openings and body phrases pass',()=>{
  assert.ok(repeatedOpening('小宇，谢谢你的关心。','小宇',[replyOpening('阿豪，谢谢你的玫瑰。','阿豪')]));
  assert.equal(repeatedOpening('专门来打听姐姐的感情八卦啦？','小宇',[replyOpening('哎呀阿豪，五朵玫瑰真香。','阿豪')]),undefined);
  assert.equal(repeatedOpening('你这么一问，姐姐都想说哎呀了。','小宇',[replyOpening('哎呀阿豪，五朵玫瑰真香。','阿豪')]),undefined);
  assert.equal(repeatedOpening('小宇，你的问题很有意思。','小宇',[replyOpening('阿豪，礼物收到了。','阿豪')]),undefined);
});
