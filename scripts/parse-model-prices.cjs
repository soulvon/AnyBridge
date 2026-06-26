const fs = require('fs');
const path = require('path');

const file = path.join(require('os').tmpdir(), 'model_prices.json');
const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);

const keys = Object.keys(data).filter(k => k !== 'sample_spec');

// Grok 4 clean names only
console.log('=== Grok 4 (clean) ===');
const grok4 = keys.filter(k => /^grok-4/i.test(k));
for (const k of grok4) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Grok 3 clean
console.log('\n=== Grok 3 (clean) ===');
const grok3 = keys.filter(k => /^grok-3/i.test(k));
for (const k of grok3) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Grok 2 clean
console.log('\n=== Grok 2 (clean) ===');
const grok2 = keys.filter(k => /^grok-2/i.test(k));
for (const k of grok2) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Llama 4 clean
console.log('\n=== Llama 4 (clean) ===');
const llama4 = keys.filter(k => /^llama-?4/i.test(k));
for (const k of llama4) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Llama 3 clean
console.log('\n=== Llama 3 (clean) ===');
const llama3 = keys.filter(k => /^llama-?3/i.test(k));
for (const k of llama3) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Mistral clean
console.log('\n=== Mistral (clean) ===');
const mistral = keys.filter(k => /^mistral-/i.test(k));
for (const k of mistral) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Mixtral clean
console.log('\n=== Mixtral (clean) ===');
const mixtral = keys.filter(k => /^mixtral/i.test(k));
for (const k of mixtral) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}

// Codestral clean
console.log('\n=== Codestral (clean) ===');
const codestral = keys.filter(k => /^codestral/i.test(k));
for (const k of codestral) {
  const e = data[k];
  console.log(`${k}\t${e.max_input_tokens||'-'}\t${e.max_output_tokens||'-'}`);
}
