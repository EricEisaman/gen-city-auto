import puppeteer from 'puppeteer';
const b = await puppeteer.launch({headless: true});
const p = await b.newPage();
import http from 'node:http'; const s = http.createServer((q, r) => r.end('<html></html>')).listen(3999); await p.goto('http://localhost:3999/');
console.log(await p.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  if (!a) return 'no adapter';
  return JSON.stringify({info: a.info, features: [...a.features], limits: {maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize, maxStorageBuffersPerShaderStage: a.limits.maxStorageBuffersPerShaderStage, maxBufferSize: a.limits.maxBufferSize}});
}));
await b.close(); s.close();
