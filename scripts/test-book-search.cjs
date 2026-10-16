const {test} = require('node:test');
const assert = require('node:assert/strict');
const {search} = require('../assets/book-search.js');

const documents = [
  {chapterId:'chapter-1',number:1,title:'认识开源模型',headingId:'c1-s1',heading:'模型的边界',text:'模型可以用 LoRA 适配业务。'},
  {chapterId:'chapter-22',number:22,title:'使用 DiffSynth 训练图像 LoRA',headingId:'',heading:'',text:'定制图像模型。'},
  {chapterId:'chapter-22',number:22,title:'使用 DiffSynth 训练图像 LoRA',headingId:'c22-s2',heading:'准备训练数据',text:'示例使用 metadata.csv 记录图片与提示词。'},
  {chapterId:'chapter-22',number:22,title:'使用 DiffSynth 训练图像 LoRA',headingId:'c22-s3',heading:'配置训练参数',text:'用 LoRA 调整图像风格。'},
  {chapterId:'chapter-19',number:19,title:'企业知识问答 RAG',headingId:'c19-s2',heading:'检索与召回',text:'检索之后对候选结果进行重排。'}
];

test('章节标题优先于正文，标题命中不重复返回无关小节',()=>{
  const result=search(documents,'lora');
  assert.equal(result.results[0].chapterId,'chapter-22');
  assert.equal(result.results[0].headingId,'');
  assert(!result.results.some(r=>r.headingId==='c22-s2'));
  assert(result.results.some(r=>r.headingId==='c22-s3'));
});
test('正文匹配保留准确的小节锚点与上下文',()=>{
  const {results}=search(documents,'METADATA.CSV');
  assert.equal(results.length,1);
  assert.equal(results[0].headingId,'c22-s2');
  assert.match(results[0].snippet,/metadata.csv/);
});
test('多个关键词可跨章节标题和小节正文匹配',()=>{
  const {results}=search(documents,' RAG  重排 ');
  assert.equal(results.length,1);
  assert.equal(results[0].headingId,'c19-s2');
  assert.equal(search(documents,'RAG 不存在的词').total,0);
});
test('支持章号并且空查询不倾倒整本书',()=>{
  assert.equal(search(documents,'第22章').results[0].chapterId,'chapter-22');
  assert.equal(search(documents,'  ').total,0);
});
test('匹配截断前保留总数，摘要能定位长正文末尾的命中',()=>{
  const long={...documents[0],text:'前文。'.repeat(500)+'独有关键词在这里。'+'后文。'.repeat(500)};
  const {results,total}=search([long,long,long],'独有关键词',2);
  assert.equal(total,3);assert.equal(results.length,2);
  assert.match(results[0].snippet,/独有关键词/);
  assert(results[0].snippet.length<=160);
});
test('标点按字面搜索，不将用户输入当成正则表达式',()=>{
  assert.equal(search(documents,'[.*').total,0);
  assert.equal(search(documents,'ｍｅｔａｄａｔａ.csv').total,1);
});
