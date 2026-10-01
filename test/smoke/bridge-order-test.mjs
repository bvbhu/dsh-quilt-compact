/**
 * Minimal decisive test: with a real webServer provided on the context,
 * does mounting QuiltCompactEngine register the bridge routes?
 * Two orders: webServer BEFORE engine, and engine BEFORE webServer
 * (the latter emulates activation order where webServer activates late).
 */
import { Context } from '@deepseek-ai/cordis';

const routes = [];
const fakeWebServer = {
  register(route) {
    routes.push(route);
    return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
  },
};

const drain = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };

const { default: QuiltCompactEngine } = await import('../../lib/index.js');
const config = { tiers: [{ name: 't', models: [{ provider: 'p', model: 'm', cooldownHours: 1 }] }] };

// case 1: webServer first
{
  routes.length = 0;
  const ctx = new Context();
  ctx.provide('llm', { async listProviders() { return []; }, async listModels() { return []; } });
  ctx.provide('tokenMeter', { measure() { return { totalTokens: 0 }; } });
  ctx.provide('sessions', { async flush() {} });
  ctx.provide('webServer', fakeWebServer);
  ctx.plugin(QuiltCompactEngine, config);
  await drain();
  console.log('case webServer-first: routes =', routes.map((r) => r.path).join(', ') || '(none)');
  await ctx.dispose?.();
}

// case 2: engine first, webServer late (provide after a tick)
{
  routes.length = 0;
  const ctx = new Context();
  ctx.provide('llm', { async listProviders() { return []; }, async listModels() { return []; } });
  ctx.provide('tokenMeter', { measure() { return { totalTokens: 0 }; } });
  ctx.provide('sessions', { async flush() {} });
  ctx.plugin(QuiltCompactEngine, config);
  await drain();
  console.log('case engine-first (before webServer): routes =', routes.map((r) => r.path).join(', ') || '(none)');
  ctx.provide('webServer', fakeWebServer);
  await drain();
  console.log('after webServer provided: routes =', routes.map((r) => r.path).join(', ') || '(none)');
  await ctx.dispose?.();
}